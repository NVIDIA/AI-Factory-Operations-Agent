// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { notificationEvents, webhookServer } from '../files/alertmanager-webhook.mjs';

const token = 'inbound-test-token-'.repeat(3);
const uiToken = 'outbound-test-token-'.repeat(3);
const path = '/api/alertmanager/webhook';
const first = '0123456789abcdef';
const second = 'fedcba9876543210';
function alert(fingerprint = first, status = 'firing') {
  return {
    fingerprint, status,
    labels: { alertname: 'MosaicWebhookTest', severity: 'warning', instance: 'node.example.com' },
    annotations: { summary: 'Synthetic alert', description: 'No cluster fault', runbook_url: 'https://example.com/runbook' },
    startsAt: '2026-10-29T01:00:00Z',
    endsAt: status === 'resolved' ? '2026-10-29T01:05:00Z' : '0001-01-01T00:00:00Z',
    generatorURL: 'https://prometheus.example.com/graph',
  };
}
function notification(...alerts) {
  return { version: '4', status: 'firing', receiver: 'mosaic', groupKey: '{}:{alertname="MosaicWebhookTest"}',
    truncatedAlerts: 0, groupLabels: {}, commonLabels: {}, commonAnnotations: {},
    externalURL: 'https://alerts.example.com', alerts: alerts.length ? alerts : [alert()] };
}
async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function fixture(t, options = {}) {
  const events = new Map();
  const requests = [];
  const uiUrl = await listen(t, createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    assert.equal(request.headers.authorization, `Bearer ${uiToken}`);
    if (await options.beforeResponse?.(request, response, body)) return;
    if (request.method === 'POST') {
      const stage = events.get(body.id)?.stage || 'active';
      events.set(body.id, { ...body, stage });
      response.end(JSON.stringify({ success: true, event: events.get(body.id) }));
    } else {
      const removed = events.delete(new URL(request.url, 'http://localhost').searchParams.get('id'));
      response.end(JSON.stringify({ success: true, removed }));
    }
  }));
  const receiverUrl = await listen(t, webhookServer({ token, uiToken, uiUrl, timeoutMs: options.timeoutMs || 15000 }));
  const post = (value = notification(), init = {}) => fetch(receiverUrl + path, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(value), ...init,
  });
  return { events, requests, receiverUrl, post };
}

test('maps full per-alert metadata and honors resolved status inside a firing group', () => {
  const input = notification(alert(), alert(second, 'resolved'));
  const [firing, resolved] = notificationEvents(input);
  assert.deepEqual(firing, {
    id: `alertmanager:${first}`, source: 'alertmanager',
    payload: 'MosaicWebhookTest | Synthetic alert | No cluster fault | severity=warning | instance=node.example.com',
    status: 'firing', fingerprint: first,
    labels: input.alerts[0].labels, annotations: input.alerts[0].annotations,
    startsAt: input.alerts[0].startsAt, endsAt: input.alerts[0].endsAt,
    createdAt: input.alerts[0].startsAt, generatorURL: input.alerts[0].generatorURL,
  });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.id, `alertmanager:${second}`);
});

test('bounds the display text while preserving complete annotations and labels', () => {
  const input = notification();
  input.alerts[0].annotations.description = 'long detail '.repeat(2000);
  const [event] = notificationEvents(input);
  assert.equal(event.payload.length, 1000);
  assert.deepEqual(event.annotations, input.alerts[0].annotations);
  assert.deepEqual(event.labels, input.alerts[0].labels);
});

test('fails closed on missing/short/equal tokens and invalid UI destinations', () => {
  for (const config of [{ token: '' }, { uiToken: '' }, { token: uiToken }, { token: 'x'.repeat(32) + '\n' },
    { uiUrl: 'https://user:password@example.com' }, { uiUrl: 'https://example.com/private' },
    { uiUrl: 'https://example.com?token=secret' }, { uiUrl: 'file:///tmp/ui' }, { timeoutMs: 0 }]) {
    assert.throws(() => webhookServer({ token, uiToken, uiUrl: 'http://mosaic-ui:3000', ...config }));
  }
});

test('rejects unauthorized requests and exposes only an unauthenticated health check', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(undefined, { headers: { 'content-type': 'application/json' } })).status, 401);
  assert.equal((await f.post(undefined, { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(f.receiverUrl + '/healthz')).status, 200);
  assert.equal((await fetch(f.receiverUrl + '/api/alerts')).status, 404);
  assert.equal((await fetch(f.receiverUrl + path)).status, 405);
  assert.equal((await fetch(f.receiverUrl + path + '?url=https://example.com')).status, 404);
  assert.equal(f.requests.length, 0);
});

test('rejects non-JSON requests and malformed JSON without forwarding', async t => {
  const f = await fixture(t);
  assert.equal((await f.post(undefined, { headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await f.post(undefined, { body: '{' })).status, 400);
  assert.equal(f.requests.length, 0);
});

test('validates the entire group before delivery, including identifiers and scalar maps', async t => {
  const f = await fixture(t);
  const bad = [null, {}, { ...notification(), version: '3' }, { ...notification(), alerts: [] },
    { ...notification(), alerts: Array(1001).fill(alert()) }];
  for (const patch of [{ fingerprint: '../alerts' }, { status: 'active' }, { labels: [] },
    { annotations: { summary: { nested: true } } }, { startsAt: 'yesterday' }, { endsAt: '' }, { generatorURL: {} }]) {
    bad.push(notification(alert(), { ...alert(second), ...patch }));
  }
  for (const value of bad) assert.equal((await f.post(value)).status, 400, JSON.stringify(value).slice(0, 200));
  assert.equal(f.requests.length, 0);
});

test('rejects truncated notifications rather than acknowledging unseen alerts', async t => {
  const f = await fixture(t);
  const response = await f.post({ ...notification(), truncatedAlerts: 2 });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /max_alerts: 0/);
  assert.equal(f.requests.length, 0);
});

test('limits both Content-Length and chunked bodies to 1 MiB', async t => {
  const f = await fixture(t);
  const body = JSON.stringify({ ...notification(), padding: 'x'.repeat(1024 * 1024) });
  assert.equal((await f.post(undefined, { body })).status, 413);
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(body.slice(0, 500000)));
    controller.enqueue(new TextEncoder().encode(body.slice(500000)));
    controller.close();
  } });
  assert.equal((await f.post(undefined, { body: stream, duplex: 'half' })).status, 413);
  assert.equal(f.requests.length, 0);
});

test('retries upsert the same fingerprint without resetting its investigation stage', async t => {
  const f = await fixture(t);
  assert.equal((await f.post()).status, 200);
  f.events.get(`alertmanager:${first}`).stage = 'responding';
  assert.equal((await f.post()).status, 200);
  assert.equal(f.events.size, 1);
  assert.equal(f.events.get(`alertmanager:${first}`).stage, 'responding');
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(request => request.body.id === `alertmanager:${first}`));
  assert.ok(f.requests.every(request => request.headers.authorization !== `Bearer ${token}`));
});

test('mixed grouped notifications upsert firing alerts and remove resolved alerts idempotently', async t => {
  const f = await fixture(t);
  await f.post(notification(alert(), alert(second)));
  const mixed = notification(alert(), alert(second, 'resolved'));
  const response = await f.post(mixed);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, firing: 1, resolved: 1 });
  assert.equal(f.events.size, 1);
  assert.equal(f.events.has(`alertmanager:${first}`), true);
  assert.equal(f.requests.at(-1).url, '/api/alerts?id=alertmanager%3Afedcba9876543210');
  assert.equal((await f.post(mixed)).status, 200);
  assert.equal(f.events.size, 1);
});

test('returns 502 on partial downstream failure and safely accepts a complete retry', async t => {
  let fail = true;
  const f = await fixture(t, { beforeResponse: (_request, response, body) => {
    if (fail && body?.fingerprint === second) {
      response.writeHead(503);
      response.end(JSON.stringify({ success: false, secret: uiToken }));
      return true;
    }
  } });
  const group = notification(alert(), alert(second));
  const failed = await f.post(group);
  assert.equal(failed.status, 502);
  assert.equal((await failed.text()).includes(uiToken), false);
  assert.equal(f.events.size, 1);
  fail = false;
  assert.equal((await f.post(group)).status, 200);
  assert.equal(f.events.size, 2);
  assert.equal(f.requests.length, 4);
});

test('does not acknowledge login HTML, redirects, suppression, or success:false', async t => {
  const f = await fixture(t, { beforeResponse: (_request, response) => {
    if (mode === 'redirect') response.writeHead(302, { location: 'https://example.com' });
    response.end(mode === 'html' ? '<html>login</html>' : JSON.stringify(
      mode === 'suppressed' ? { success: true, suppressed: true } : { success: false }));
    return true;
  } });
  let mode;
  for (mode of ['html', 'redirect', 'suppressed', 'error']) assert.equal((await f.post()).status, 502);
  assert.equal(f.events.size, 0);
});

test('bounds total downstream delivery time and releases the busy state after a timeout', async t => {
  const f = await fixture(t, { timeoutMs: 20, beforeResponse: async () => {
    await new Promise(resolve => setTimeout(resolve, 100));
  } });
  assert.equal((await f.post()).status, 502);
  assert.equal((await f.post()).status, 502);
});

test('returns retryable backpressure while processing another grouped notification', async t => {
  let release;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { beforeResponse: async () => { started(); await blocked; } });
  const pending = f.post();
  await waiting;
  assert.equal((await f.post()).status, 503);
  release();
  assert.equal((await pending).status, 200);
  assert.equal(f.requests.length, 1);
});

test('real Alertmanager delivers grouped firing and resolved notifications with bearer authentication', {
  skip: !process.env.ALERTMANAGER_BINARY,
  timeout: 30000,
}, async t => {
  const f = await fixture(t);
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-alertmanager-test-'));
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  await writeFile(join(directory, 'token'), token, { mode: 0o600 });
  await writeFile(join(directory, 'alertmanager.yml'), `
route:
  receiver: mosaic
  group_by: [alertname]
  group_wait: 0s
  group_interval: 1s
  repeat_interval: 1h
receivers:
  - name: mosaic
    webhook_configs:
      - url: ${f.receiverUrl}${path}
        send_resolved: true
        max_alerts: 0
        http_config:
          authorization:
            credentials_file: ${join(directory, 'token')}
`, { mode: 0o600 });
  const processHandle = spawn(process.env.ALERTMANAGER_BINARY, [
    `--config.file=${join(directory, 'alertmanager.yml')}`, `--storage.path=${directory}`,
    `--web.listen-address=127.0.0.1:${port}`, '--cluster.listen-address=', '--log.level=warn',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let logs = '';
  let startError;
  processHandle.stderr.on('data', chunk => { logs += chunk; });
  processHandle.on('error', error => { startError = error; });
  t.after(async () => {
    if (processHandle.exitCode === null && processHandle.pid) {
      const exited = new Promise(resolve => processHandle.once('exit', resolve));
      processHandle.kill('SIGTERM');
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });
  async function until(check) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (startError) throw startError;
      if (processHandle.exitCode !== null) throw new Error(`Alertmanager exited: ${logs}`);
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail(`Timed out waiting for real Alertmanager delivery: ${logs}`);
  }
  await until(async () => {
    try { return (await fetch(base + '/-/ready')).ok; } catch { return false; }
  });
  const startsAt = new Date(Date.now() - 5000).toISOString();
  const endsAt = new Date(Date.now() + 300000).toISOString();
  const alerts = ['node-a.example.com', 'node-b.example.com'].map(instance => ({
    labels: { alertname: 'MosaicWebhookSmokeTest', severity: 'warning', instance },
    annotations: { summary: 'Synthetic delivery test; no cluster fault' },
    startsAt, endsAt, generatorURL: 'https://example.com/mosaic-webhook-test',
  }));
  async function submit(values) {
    const response = await fetch(base + '/api/v2/alerts', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(values),
    });
    assert.equal(response.status, 200, await response.text());
  }
  await submit(alerts);
  await until(() => f.events.size === 2);
  assert.ok([...f.events.keys()].every(id => /^alertmanager:[a-f0-9]{16}$/.test(id)));
  assert.deepEqual([...f.events.values()].map(event => event.labels.instance).sort(),
    ['node-a.example.com', 'node-b.example.com']);
  await submit([{ ...alerts[0], endsAt: new Date().toISOString() }]);
  await until(() => f.events.size === 1 && [...f.events.values()][0].labels.instance === 'node-b.example.com');
  await submit([{ ...alerts[1], endsAt: new Date().toISOString() }]);
  await until(() => f.events.size === 0);
  assert.ok(f.requests.some(request => request.method === 'POST'));
  assert.ok(f.requests.filter(request => request.method === 'DELETE').length >= 2);
});
