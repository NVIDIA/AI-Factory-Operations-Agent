// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createCompatibilityServer } from '../files/llm-compat-server.mjs';

const search = { type: 'function', function: { name: 'opensearch_search', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } };
const task = { type: 'function', function: { name: 'task', parameters: { type: 'object' } } };
const input = () => ({ model: 'test-model', messages: [{ role: 'user', content: 'Search the indexed PDF.' }], tools: [search, task], stream: true, temperature: 1, max_completion_tokens: 4096 });
function frames(content, { calls, finish = 'stop', done = true, usage, choices } = {}) {
  const meta = { id: 'chatcmpl-real-upstream', model: 'test-model', created: 1793400000, object: 'chat.completion.chunk' };
  const delta = calls ? { tool_calls: calls } : { content };
  const result = [
    { ...meta, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] },
    { ...meta, choices: choices || [{ index: 0, delta, finish_reason: null }] },
    { ...meta, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  ];
  if (usage) result.push({ ...meta, choices: [], usage });
  return Buffer.from(result.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''));
}
function parseFrames(body) {
  return body.toString().split('\n').filter(line => line.startsWith('data: ') && line !== 'data: [DONE]').map(line => JSON.parse(line.slice(6)));
}
function returnedCall(body) {
  return parseFrames(body).flatMap(event => event.choices || []).flatMap(choice => choice.delta?.tool_calls || [])[0];
}
async function request(base, body, path = '/v1/chat/completions') {
  return new Promise((resolveRequest, reject) => {
    const req = http.request(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer never-record-this-auth-value' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolveRequest({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function fixture(options, run) {
  const upstreamRequests = [], events = [];
  const auditDirectory = await mkdtemp(join(tmpdir(), 'mosaic-research-compat-'));
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({ path: req.url, headers: req.headers, body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
    if (options.handler) return options.handler(req, res);
    const response = options.response || frames('{"query":"MOSAIC-KB page 2"}');
    res.writeHead(options.status || 200, { 'Content-Type': 'text/event-stream', ...options.headers });
    if (options.fragment) {
      for (const byte of response) res.write(Buffer.from([byte]));
      res.end();
    } else res.end(response);
  });
  await new Promise(resolveListen => upstream.listen(0, '127.0.0.1', resolveListen));
  const proxy = createCompatibilityServer({ upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, researchToolCalls: options.enabled !== false, auditDirectory: options.audit ? auditDirectory : '', log: value => events.push(value), ...options.server });
  await new Promise(resolveListen => proxy.listen(0, '127.0.0.1', resolveListen));
  try {
    await run(`http://127.0.0.1:${proxy.address().port}`, upstreamRequests, auditDirectory, events);
  } finally {
    upstream.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise(resolveClose => upstream.close(resolveClose)), new Promise(resolveClose => proxy.close(resolveClose))]);
    await rm(auditDirectory, { recursive: true });
  }
}

test('disabled research compatibility preserves the existing no-reasoning contract and raw reply', async () => {
  const raw = frames('{"query":"plain unexecuted text"}');
  await fixture({ enabled: false, response: raw, audit: true }, async (base, requests, directory) => {
    const body = input();
    const result = await request(base, body);
    assert.deepEqual(result.body, raw);
    assert.deepEqual(requests[0].body, { ...body, reasoning_effort: 'none' });
    assert.deepEqual(await readdir(directory), []);
  });
});

test('normalizes only complete named query arguments and retains the full original audit', async () => {
  const argumentsText = JSON.stringify({ query: '完整检索内容。'.repeat(1000) }, null, 2);
  const raw = frames(argumentsText);
  await fixture({ response: raw, audit: true, fragment: true }, async (base, requests, directory, events) => {
    const body = input();body.chat_template_kwargs = { custom_setting: 'retained' };
    const result = await request(base, body);
    assert.equal(result.status, 200);
    const call = returnedCall(result.body);
    assert.equal(call.function.name, 'opensearch_search');
    assert.equal(call.function.arguments, argumentsText);
    assert.deepEqual(requests[0].body.chat_template_kwargs, { custom_setting: 'retained', enable_thinking: false });
    assert.deepEqual(requests[0].body.tool_choice, { type: 'function', function: { name: 'opensearch_search' } });
    assert.deepEqual(requests[0].body.messages, body.messages);
    const files = await readdir(directory);assert.equal(files.length, 1);
    const audit = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
    assert.deepEqual(Buffer.from(audit.upstreamResponseBase64, 'base64'), raw);
    assert.deepEqual(Buffer.from(audit.returnedResponseBase64, 'base64'), result.body);
    assert.deepEqual(JSON.parse(Buffer.from(audit.originalRequestBase64, 'base64')), body);
    assert.equal(audit.normalizationPerformed, true);
    assert.equal(audit.upstreamResponseComplete, true);
    assert.ok(!JSON.stringify(audit).includes('never-record-this-auth-value'));
    assert.equal(events[0].toolCallId, call.id);
  });
});

test('already structured named calls pass through byte for byte', async () => {
  const raw = frames('', { calls: [{ index: 0, id: 'call_actual_provider', type: 'function', function: { name: 'opensearch_search', arguments: '{"query":"actual query"}' } }], finish: 'tool_calls' });
  await fixture({ response: raw }, async (base, _requests, _directory, events) => {
    const result = await request(base, input());assert.deepEqual(result.body, raw);assert.deepEqual(events, []);
  });
});

for (const [name, modify] of [
  ['explicit none', body => { body.tool_choice = 'none'; }],
  ['another named tool', body => { body.tool_choice = { type: 'function', function: { name: 'task' } }; }],
  ['post-search synthesis', body => { body.messages.push({ role: 'tool', tool_call_id: 'actual', content: 'Full retrieved document content.' }); }],
  ['subagent without task', body => { body.tools = [search]; }],
  ['unrelated OpenClaw tools', body => { body.tools = [task]; }],
  ['multiple requested choices', body => { body.n = 2; }],
  ['a different search schema', body => { body.tools = [{ ...search, function: { ...search.function, parameters: { ...search.function.parameters, required: ['query', 'collection'] } } }, task]; }],
]) {
  test(`${name} is forwarded without a forced search or response rewrite`, async () => {
    const raw = frames('A complete ordinary response.');
    await fixture({ response: raw }, async (base, requests) => {
      const body = input();modify(body);
      const result = await request(base, body);assert.deepEqual(result.body, raw);
      assert.deepEqual(requests[0].body, { ...body, reasoning_effort: 'none' });
    });
  });
}

test('nonstream callers receive real tool arguments and complete provider usage', async () => {
  const usage = { prompt_tokens: 17, completion_tokens: 8, total_tokens: 25, completion_tokens_details: { reasoning_tokens: 0 } };
  await fixture({ response: frames('{"query":"indexed doc"}', { usage }) }, async (base, requests) => {
    const body = input();body.stream = false;
    const result = await request(base, body);const value = JSON.parse(result.body);
    assert.equal(value.object, 'chat.completion');assert.deepEqual(value.usage, usage);
    assert.equal(value.choices[0].message.tool_calls[0].function.arguments, '{"query":"indexed doc"}');
    assert.equal(requests[0].body.stream, true);assert.equal(requests[0].body.stream_options.include_usage, true);
  });
});

for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
  test(`handles complete ${encoding} upstream frames`, async () => {
    await fixture({ response: compress(frames('{"query":"GPU 文档"}')), headers: { 'Content-Encoding': encoding } }, async base => {
      const result = await request(base, input());assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(returnedCall(result.body).function.arguments), { query: 'GPU 文档' });
      assert.equal(result.headers['content-encoding'], undefined);
    });
  });
}

for (const content of ['I will search. {"query":"a"}', '{"query":', '{"query":""}', '{"query":123}', '{}', '[]', '{"query":"a","unexpected":"b"}']) {
  test(`rejects unsupported arguments without inventing a call: ${content}`, async () => {
    const raw = frames(content);
    await fixture({ response: raw, audit: true }, async (base, _requests, directory) => {
      const result = await request(base, input());assert.equal(result.status, 502);
      assert.ok(!result.body.toString().includes('call_research_'));
      const files = await readdir(directory);assert.equal(files.length, 1);
      const audit = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
      assert.deepEqual(Buffer.from(audit.upstreamResponseBase64, 'base64'), raw);
      assert.equal(audit.returnedSuccess, false);
    });
  });
}

for (const [name, options] of [['missing terminator', { done: false }], ['token exhaustion', { finish: 'length' }], ['filtered output', { finish: 'content_filter' }]]) {
  test(`${name} cannot become a successful tool call`, async () => {
    await fixture({ response: frames('{"query":"valid but incomplete generation"}', options) }, async base => {
      assert.equal((await request(base, input())).status, 502);
    });
  });
}

test('upstream failures preserve their status and complete body', async () => {
  const body = Buffer.from('{"error":{"message":"upstream denied"}}');
  await fixture({ status: 401, response: body, headers: { 'Content-Type': 'application/json' } }, async base => {
    const result = await request(base, input());assert.equal(result.status, 401);assert.deepEqual(result.body, body);
  });
});

test('unexpected tools cannot replace the explicitly selected read-only search', async () => {
  const raw = frames('', { calls: [{ index: 0, id: 'wrong', type: 'function', function: { name: 'task', arguments: '{}' } }], finish: 'tool_calls' });
  await fixture({ response: raw }, async base => { assert.equal((await request(base, input())).status, 502); });
});

test('oversized buffered responses fail instead of truncating arguments', async () => {
  await fixture({ response: frames(JSON.stringify({ query: 'a'.repeat(4096) })), server: { maxBufferedBytes: 1024 } }, async base => {
    assert.equal((await request(base, input())).status, 502);
  });
});

test('an upstream timeout returns an error rather than a fabricated tool result', async () => {
  await fixture({ server: { timeoutMs: 25 }, handler: (_req, res) => { setTimeout(() => { if (!res.destroyed) res.end('late'); }, 100); } }, async base => {
    assert.equal((await request(base, input())).status, 502);
  });
});

test('health does not call the model or create an audit', async () => {
  await fixture({ audit: true }, async (base, requests, directory) => {
    const result = await request(base, undefined, '/health');assert.equal(result.status, 200);assert.equal(result.body.toString(), 'ok');
    assert.deepEqual(requests, []);assert.deepEqual(await readdir(directory), []);
  });
});

test('the CLI starts through a ConfigMap-style symbolic link', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mosaic-research-entrypoint-'));
  const link = join(directory, 'server.mjs');
  await symlink(fileURLToPath(new URL('../files/llm-compat-server.mjs', import.meta.url)), link);
  const reserve = http.createServer();
  await new Promise(resolveListen => reserve.listen(0, '127.0.0.1', resolveListen));
  const port = reserve.address().port;
  await new Promise(resolveClose => reserve.close(resolveClose));
  const child = spawn(process.execPath, [link], { env: { ...process.env, PORT: String(port), UPSTREAM_BASE_URL: 'http://127.0.0.1:1/v1', RESEARCH_TOOL_CALLS_ENABLED: 'true' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    let result;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, stderr || 'CLI exited before listening');
      try { result = await request(`http://127.0.0.1:${port}`, undefined, '/health'); break; }
      catch { await delay(25); }
    }
    assert.equal(result?.status, 200, stderr || 'CLI did not listen');
    assert.equal(result.body.toString(), 'ok');
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    await closed;
    await rm(directory, { recursive: true });
  }
});
