// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_ALERTS = 1000;
const WEBHOOK_PATH = '/api/alertmanager/webhook';

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function stringMap(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.values(value).some(item => typeof item !== 'string')) {
    throw new RequestError(400, `${name} must be an object containing strings`);
  }
  return value;
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
      || !Number.isFinite(Date.parse(value))) {
    throw new RequestError(400, `${name} must be an RFC3339 timestamp`);
  }
  return value;
}

// Validate the entire notification before sending any of its alerts downstream.
export function notificationEvents(notification) {
  if (!notification || notification.version !== '4'
      || !['firing', 'resolved'].includes(notification.status)
      || !Array.isArray(notification.alerts) || !notification.alerts.length
      || notification.alerts.length > MAX_ALERTS) {
    throw new RequestError(400, `expected an Alertmanager v4 notification with 1-${MAX_ALERTS} alerts`);
  }
  if (notification.truncatedAlerts !== undefined && notification.truncatedAlerts !== 0) {
    throw new RequestError(422, 'truncated notifications are unsupported; configure max_alerts: 0');
  }
  return notification.alerts.map(alert => {
    if (!alert || !['firing', 'resolved'].includes(alert.status)
        || typeof alert.fingerprint !== 'string' || !/^[a-f0-9]{16}$/.test(alert.fingerprint)) {
      throw new RequestError(400, 'each alert requires a status and a lowercase 16-digit hexadecimal fingerprint');
    }
    const labels = stringMap(alert.labels, 'labels');
    const annotations = stringMap(alert.annotations, 'annotations');
    const startsAt = timestamp(alert.startsAt, 'startsAt');
    const endsAt = timestamp(alert.endsAt, 'endsAt');
    if (alert.generatorURL !== undefined && typeof alert.generatorURL !== 'string') {
      throw new RequestError(400, 'generatorURL must be a string');
    }
    const details = [labels.alertname || 'Alertmanager alert', annotations.summary, annotations.description,
      ...Object.entries(labels).filter(([key]) => key !== 'alertname').map(([key, value]) => `${key}=${value}`)];
    return {
      id: `alertmanager:${alert.fingerprint}`,
      source: 'alertmanager',
      payload: details.filter(Boolean).join(' | ').replace(/\s+/g, ' ').slice(0, 1000),
      status: alert.status,
      fingerprint: alert.fingerprint,
      labels,
      annotations,
      startsAt,
      endsAt,
      createdAt: startsAt,
      ...(alert.generatorURL ? { generatorURL: alert.generatorURL } : {}),
    };
  });
}

async function readNotification(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      request.resume();
      throw new RequestError(413, 'notification exceeds 1 MiB');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'invalid JSON');
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

export function webhookServer({ token, uiToken, uiUrl, timeoutMs = 15000, fetchImpl = fetch }) {
  // Independent inbound/outbound credentials: Alertmanager never receives the UI machine token.
  for (const [name, value] of Object.entries({ token, uiToken })) {
    if (typeof value !== 'string' || value.trim().length < 32 || /[\r\n]/.test(value)) {
      throw new Error(`${name} must contain at least 32 characters and no newlines`);
    }
  }
  if (token === uiToken) throw new Error('webhook and UI tokens must be different');
  const base = new URL(uiUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
      || !['', '/'].includes(base.pathname)) throw new Error('uiUrl must be an HTTP(S) origin');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw new Error('timeoutMs must be an integer between 1 and 60000');
  }
  const expectedAuthorization = digest(`Bearer ${token}`);
  let busy = false;
  const server = createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    if (request.url === '/healthz' && request.method === 'GET') return reply(200, { ok: true });
    if (request.url !== WEBHOOK_PATH) return reply(404, { error: 'not found' });
    if (request.method !== 'POST') {
      response.setHeader('allow', 'POST');
      return reply(405, { error: 'POST required' });
    }
    if (!timingSafeEqual(expectedAuthorization, digest(request.headers.authorization || ''))) {
      return reply(401, { error: 'unauthorized' });
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
      return reply(415, { error: 'application/json required' });
    }
    if (Number(request.headers['content-length']) > MAX_BODY_BYTES) return reply(413, { error: 'notification exceeds 1 MiB' });
    // Bound work and preserve order within each grouped delivery. Alertmanager retries 5xx.
    if (busy) return reply(503, { error: 'receiver busy; retry notification' });
    busy = true;
    try {
      const events = notificationEvents(await readNotification(request));
      const signal = AbortSignal.timeout(timeoutMs);
      let firing = 0;
      let resolved = 0;
      for (const event of events) {
        const isResolved = event.status === 'resolved';
        const url = new URL('/api/alerts', base);
        if (isResolved) url.searchParams.set('id', event.id);
        const downstream = await fetchImpl(url, {
          method: isResolved ? 'DELETE' : 'POST',
          headers: { authorization: `Bearer ${uiToken}`, 'content-type': 'application/json' },
          ...(isResolved ? {} : { body: JSON.stringify(event) }),
          redirect: 'error',
          signal,
        });
        // A redirect/login page/200 error object must not acknowledge a lost delivery.
        const result = await downstream.json();
        if (!downstream.ok || result?.success !== true || result.suppressed === true) {
          throw new Error('MOSAIC rejected an alert');
        }
        if (isResolved) resolved++;
        else firing++;
      }
      reply(200, { success: true, firing, resolved });
    } catch (error) {
      if (error instanceof RequestError) reply(error.status, { error: error.message });
      // Never expose downstream response bodies, alert payloads, URLs, or credentials.
      else reply(502, { error: 'MOSAIC delivery failed; retry notification' });
    } finally {
      busy = false;
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3004);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be 1024-65535');
  const server = webhookServer({
    token: process.env.MOSAIC_ALERTMANAGER_WEBHOOK_TOKEN,
    uiToken: process.env.MOSAIC_UI_MACHINE_TOKEN,
    uiUrl: process.env.MOSAIC_UI_URL,
  });
  server.listen(port, '0.0.0.0', () => console.log(`Alertmanager receiver listening on port ${port}`));
  process.on('SIGTERM', () => server.close());
}
