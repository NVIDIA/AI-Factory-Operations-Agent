// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { proxyServer, tokenProvider } from '../files/mcp-oauth-proxy.mjs';

test('renews expiring tokens and shares concurrent requests', async () => {
  let now = 0;
  let requests = 0;
  const tokens = tokenProvider({ tokenUrl: 'https://auth.example.com/token', clientId: 'client', clientSecret: 'secret' }, async (_url, options) => {
    requests++;
    assert.equal(options.body.get('grant_type'), 'client_credentials');
    return { ok: true, json: async () => ({ access_token: `token-${requests}`, token_type: 'Bearer', expires_in: 100 }) };
  }, () => now);
  assert.deepEqual(await Promise.all([tokens.get(), tokens.get()]), ['token-1', 'token-1']);
  assert.equal(requests, 1);
  now = 89_000;
  assert.equal(await tokens.get(), 'token-1');
  now = 91_000;
  assert.equal(await tokens.get(), 'token-2');
  tokens.invalidate('token-1');
  assert.equal(await tokens.get(), 'token-2');
  tokens.invalidate('token-2');
  assert.equal(await tokens.get(), 'token-3');
});

test('streams MCP responses through the authenticated proxy', async () => {
  const received = [];
  const upstream = http.createServer((request, response) => {
    received.push({ path: request.url, authorization: request.headers.authorization, session: request.headers['mcp-session-id'] });
    response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-1' });
    response.write('data: {"ok":');
    response.end('true}\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = proxyServer({ upstreamPort: upstream.address().port, path: '/mcp', tokens: { get: async () => 'token', invalidate() {} } });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/mcp`, {
      method: 'POST', headers: { 'mcp-session-id': 'session-1', authorization: 'Bearer wrong' }, body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('mcp-session-id'), 'session-1');
    assert.equal(await response.text(), 'data: {"ok":true}\n\n');
    assert.deepEqual(received, [{ path: '/mcp', authorization: 'Bearer token', session: 'session-1' }]);
    assert.equal((await fetch(`http://127.0.0.1:${proxy.address().port}/other`)).status, 404);
  } finally {
    proxy.close();
    upstream.close();
  }
});
