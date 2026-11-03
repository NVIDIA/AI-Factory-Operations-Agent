// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {once} from 'node:events';
import * as http from 'node:http';
import * as https from 'node:https';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const chart = fileURLToPath(new URL('..', import.meta.url));
for (const effort of ['none', '']) test(`compatibility proxy preserves request fields with reasoning policy ${JSON.stringify(effort)}`, async t => {
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({body: JSON.parse(Buffer.concat(chunks)), authorization: request.headers.authorization}));
  }).listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => upstream.close());
  const manifest = execFileSync('helm', ['template', 'proxy-test', chart,
    '--set-string', `llm.requestCompatibility.reasoningEffort=${effort}`,
    '--show-only', 'templates/llm-compat.yaml'], {encoding:'utf8'});
  const block = manifest.split('  server.js: |\n')[1].split('\n---')[0];
  const code = block.split('\n').map(line => line.slice(4)).join('\n');
  let proxy;
  runInNewContext(code, {
    Buffer, URL, process: {env: {PORT:'0', UPSTREAM_BASE_URL:`http://127.0.0.1:${upstream.address().port}`}},
    require: name => name === 'https' ? https : {...http, createServer: handler => (proxy = http.createServer(handler))},
  });
  await once(proxy, 'listening');
  t.after(() => proxy.close());
  for (const reasoning of [undefined, 'high']) {
    const body = {model:'configured-model', messages:[{role:'user',content:'Return a brief response.'}], temperature:0.6};
    if (reasoning) body.reasoning_effort = reasoning;
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/chat/completions`, {
      method:'POST', headers:{'content-type':'application/json', authorization:'Bearer test-credential'}, body:JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    const actual = await response.json();
    assert.deepEqual(actual.body, effort ? {...body, reasoning_effort:effort} : body);
    assert.equal(actual.authorization, 'Bearer test-credential');
  }
});
