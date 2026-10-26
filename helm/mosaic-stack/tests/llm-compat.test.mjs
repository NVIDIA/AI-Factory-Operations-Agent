// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

test('compatibility proxy supplies optional template defaults and preserves request overrides', async () => {
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.end(Buffer.concat(chunks));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  try {
    for (const defaults of [{}, { enable_thinking: false }, { template_mode: 'brief' }]) {
      const chart = fileURLToPath(new URL('..', import.meta.url));
      const output = execFileSync('helm', ['template', 'trial', chart, '--show-only', 'templates/llm-compat.yaml', '--set-json', `llm.requestCompatibility.chatTemplateKwargs=${JSON.stringify(defaults)}`], { encoding: 'utf8' });
      const code = output.split('  server.js: |\n')[1].split('\n---')[0].split('\n').map(line => line.slice(4)).join('\n');
      let proxy;
      vm.runInNewContext(code, {
        require: name => name === 'http' ? { ...http, createServer: handler => (proxy = http.createServer(handler)) } : https,
        process: { env: { UPSTREAM_BASE_URL: `http://127.0.0.1:${upstream.address().port}`, PORT: '0' } }, Buffer, URL,
      });
      await once(proxy, 'listening');
      try {
        for (const explicit of [undefined, { enable_thinking: true, template_mode: 'expanded' }]) {
          const body = { messages: [{ role: 'user', content: 'Hello' }], ...(explicit && { chat_template_kwargs: explicit }) };
          const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify(body) });
          const expected = { ...body, reasoning_effort: 'none' };
          if (Object.keys(defaults).length) expected.chat_template_kwargs = { ...defaults, ...explicit };
          assert.deepEqual(await response.json(), expected);
        }
        const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/embeddings`, { method: 'POST', body: '{"input":"hello"}' });
        assert.deepEqual(await response.json(), { input: 'hello' });
      } finally {
        proxy.closeAllConnections();
        proxy.close();
      }
    }
  } finally {
    upstream.closeAllConnections();
    upstream.close();
  }
});
