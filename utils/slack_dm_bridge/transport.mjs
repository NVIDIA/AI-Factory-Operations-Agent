// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from 'node:fs/promises';
import http from 'node:http';

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export class TransportError extends Error {
  constructor(code, {retryAfter = 0, definite = false} = {}) {
    super(code); this.retryAfter = retryAfter; this.definite = definite;
  }
}

// The socket is a local trust boundary: mount it only in the bridge process.
// The broker returns one credential at a time, never a provider URL or command.
export async function credential(config, name) {
  let value;
  if (config.credentialSocket) {
    value = await new Promise((resolve, reject) => {
      const req = http.get({socketPath:config.credentialSocket, path:'/v1/credentials/' + name,
        timeout:5000}, res => {
        let size = 0; const chunks = [];
        res.on('data', data => {
          size += data.length;
          if (size > 16384) { res.destroy(); reject(new Error('credential_response_too_large')); }
          else chunks.push(data);
        });
        res.on('error', () => reject(new Error('credential_broker_unavailable')));
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) throw new Error();
            resolve(JSON.parse(Buffer.concat(chunks).toString()).value);
          } catch { reject(new Error('credential_broker_rejected')); }
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => reject(new Error('credential_broker_unavailable')));
    });
  } else {
    const stat = await fs.stat(config.credentialsFile);
    if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o007)) throw new Error('unsafe_credential_file');
    const all = JSON.parse(await fs.readFile(config.credentialsFile, 'utf8'));
    value = all[name];
  }
  if (typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value)) throw new Error('invalid_credential');
  value = value.trim();
  if (name === 'botToken' && !value.startsWith('xoxb-')) throw new Error('bot_token_required');
  if (name === 'appToken' && !value.startsWith('xapp-')) throw new Error('app_token_required');
  if (name === 'publishToken' && value.length < 32) throw new Error('publish_token_too_short');
  return value;
}

async function boundedJson(res, maxBytes) {
  let size = 0; const chunks = [];
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) throw new TransportError('response_too_large');
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new TransportError('invalid_response'); }
}

export class Clients {
  constructor(config, {fetchFn = fetch, readCredential = credential} = {}) {
    this.config = config; this.fetch = fetchFn; this.readCredential = readCredential;
  }
  secret(name) { return this.readCredential(this.config, name); }
  async slack(method, body = {}) {
    const token = await this.secret(method === 'apps.connections.open' ? 'appToken' : 'botToken');
    const readChannel = method === 'conversations.info';
    const url = new URL('https://slack.com/api/' + method);
    if (readChannel) url.searchParams.set('channel',body.channel);
    let res;
    try {
      res = await this.fetch(url.href, {method:readChannel ? 'GET' : 'POST', redirect:'error',
        headers:{authorization:'Bearer ' + token, 'content-type':'application/json; charset=utf-8'},
        body:readChannel ? undefined : JSON.stringify(body), signal:AbortSignal.timeout(30000)});
    } catch { throw new TransportError('slack_transport_unknown'); }
    if (res.status === 429) {
      const seconds = Number(res.headers.get('retry-after'));
      throw new TransportError('slack_rate_limited', {definite:true,
        retryAfter:Math.max(1000, (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000)});
    }
    if (!res.ok) throw new TransportError('slack_http_unknown');
    const data = await boundedJson(res, 1048576);
    if (data.ok !== true) {
      // Never log Slack's response body (it may reflect credentials or user content).
      const permanent = new Set(['invalid_auth','account_inactive','token_revoked','not_authed',
        'missing_scope','channel_not_found','not_in_channel','is_archived','msg_too_long','no_text']);
      throw new TransportError('slack_api_rejected', {definite:permanent.has(data.error)});
    }
    return data;
  }
  async mosaic(path, body) {
    const token = await this.secret('mosaicToken');
    let res;
    try {
      res = await this.fetch(new URL(path, this.config.mosaicUrl), {method:body ? 'POST' : 'GET',
        redirect:'error', headers:{authorization:'Bearer ' + token, 'content-type':'application/json'},
        body:body ? JSON.stringify(body) : undefined,
        signal:AbortSignal.timeout(body ? 650000 : 30000)});
    } catch { throw new TransportError('mosaic_transport_unknown'); }
    if (!res.ok) throw new TransportError('mosaic_http_error');
    return boundedJson(res, 8388608);
  }
  async channelChat(messages) {
    const {endpoint,model} = this.config.channelModel;
    let res;
    try {
      res = await this.fetch(endpoint,{method:'POST',redirect:'error',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({model,messages,stream:false,max_tokens:1024}),
        signal:AbortSignal.timeout(90000)});
    } catch { throw new TransportError('channel_model_unavailable'); }
    if (!res.ok) throw new TransportError('channel_model_http_error');
    const data = await boundedJson(res,1048576);
    const choice = data.choices?.[0];
    if (choice?.finish_reason !== 'stop' || choice.message?.tool_calls?.length)
      throw new TransportError('channel_model_incomplete_answer');
    return choice.message?.content;
  }
}

export function socketUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'wss:' || !url.hostname.endsWith('.slack.com') ||
      url.username || url.password || url.port) throw new Error('invalid_slack_socket_url');
  return url.href;
}

// ACK only follows the synchronous durable inbox transaction. No model/API call
// runs in the socket callback. Slack redelivery is deduplicated by event_id.
export async function socketLoop(bridge, {WebSocketClass = WebSocket, wait = delay} = {}) {
  let backoff = 1000;
  while (!bridge.stopping) {
    try {
      const connection = await bridge.clients.slack('apps.connections.open');
      await new Promise((resolve, reject) => {
        const ws = new WebSocketClass(socketUrl(connection.url));
        bridge.socket = ws;
        let connected = false;
        const timeout = setTimeout(() => { ws.close(); reject(new Error('socket_connect_timeout')); }, 30000);
        // Slack refreshes connection URLs; periodically reconnect even if a dead
        // connection never delivers its disconnect frame. WebSocket handles pong.
        const refresh = setTimeout(() => ws.close(), 45 * 60 * 1000);
        const finish = () => {
          clearTimeout(timeout); clearTimeout(refresh); bridge.connected = false;
          if (bridge.socket === ws) bridge.socket = undefined;
        };
        ws.addEventListener('open', () => { connected = true; clearTimeout(timeout); });
        ws.addEventListener('message', event => {
          try {
            if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 262144) throw new Error();
            const envelope = JSON.parse(event.data);
            if (envelope.type === 'hello') { bridge.connected = true; backoff = 1000; return; }
            if (envelope.type === 'disconnect') { ws.close(); return; }
            if (typeof envelope.envelope_id !== 'string') return;
            bridge.accept(envelope);
            ws.send(JSON.stringify({envelope_id:envelope.envelope_id}));
          } catch {
            // Capacity/disk failure is not acknowledged: Slack can retry.
            bridge.log('socket_event_not_acknowledged'); ws.close();
          }
        });
        ws.addEventListener('close', () => { finish(); resolve(); });
        ws.addEventListener('error', () => {
          finish(); ws.close(); reject(new Error(connected ? 'socket_disconnected' : 'socket_connect_failed'));
        });
      });
    } catch { bridge.log('socket_reconnecting'); }
    if (!bridge.stopping) await wait(backoff);
    backoff = Math.min(backoff * 2, 30000);
  }
}
