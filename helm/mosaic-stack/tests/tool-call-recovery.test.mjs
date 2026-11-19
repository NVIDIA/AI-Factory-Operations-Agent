// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import recovery from '../files/tool-call-recovery.cjs';

const { recoverToolCallText } = recovery;
const bad = 'Let me gather cluster status now.\n\n<run_kubectl args=["get", "nodes", "-o", "wide"]}';
const call = { id: 'call-provider-original', type: 'function', function: { name: 'run_kubectl', arguments: '{"cluster":"test","args":["get","nodes"]}' } };
const request = { model: 'test', messages: [{ role: 'system', content: 'Read-only. Never bypass a denial.' },
  { role: 'user', content: 'Check the test cluster.' }], tools: [{ type: 'function', function: {
    name: 'run_kubectl', parameters: { type: 'object', properties: { cluster: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } }, required: ['args'] },
  } }], tool_choice: 'auto', stream: true, temperature: 0.2 };
function completion(content, { calls = [], stream = true, done = true, finish = calls.length ? 'tool_calls' : 'stop' } = {}) {
  const meta = { id: 'chat-original', created: 123, model: 'test' };
  const usage = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 };
  if (!stream) return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...meta,
    choices: [{ index: 0, message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finish }], usage }) };
  return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: [
    { ...meta, choices: [{ index: 0, delta: { content, ...(calls.length ? { tool_calls: calls.map((c, index) => ({ ...c, index })) } : {}) }, finish_reason: null }] },
    { ...meta, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    { ...meta, choices: [], usage },
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : '') };
}
async function fixture(t, replies, options = {}) {
  const received = [], logs = [];
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    received.push(JSON.parse(raw));
    const result = replies[Math.min(received.length - 1, replies.length - 1)];
    if (result.delay) await new Promise(resolve => setTimeout(resolve, result.delay));
    if (!res.destroyed) res.writeHead(result.status, result.headers).end(result.body);
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = http.createServer(async (req, res) => {
    const parts = []; for await (const part of req) parts.push(part);
    const body = Buffer.concat(parts), target = new URL(req.url, `http://127.0.0.1:${upstream.address().port}`);
    if (!await recoverToolCallText({ req, res, target, body, log: e => logs.push(e), ...options })) res.writeHead(204).end();
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { proxy.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([proxy, upstream].map(s => new Promise(r => s.close(r)))); });
  return { received, logs, send: (body = request) => fetch(`http://127.0.0.1:${proxy.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) };
}
for (const stream of [true, false]) test(`repairs observed invocation text once; preserves native ${stream ? 'SSE' : 'JSON'} calls`, async t => {
  const valid = completion(null, { calls: [call], stream });
  const { send, received, logs } = await fixture(t, [completion(bad, { stream }), valid]);
  const response = await send({ ...request, stream });
  assert.equal(response.status, 200); assert.equal(await response.text(), valid.body);
  assert.equal(received.length, 2);
  const retry = received[1];
  assert.deepEqual(retry.tools, request.tools); assert.equal(retry.tool_choice, 'auto'); assert.equal(retry.temperature, 0.2);
  assert.deepEqual(retry.messages.slice(1), request.messages.slice(1));
  assert.equal(retry.messages[0].role, 'system');
  assert.ok(retry.messages[0].content.startsWith(request.messages[0].content));
  assert.match(retry.messages[0].content, /nothing.*was executed/);
  assert.ok(!JSON.stringify(retry.messages).includes('<run_kubectl'));
  assert.deepEqual(logs.map(l => l.event), ['tool-call-text-retry', 'tool-call-text-recovered']);
  assert.ok(logs.every(l => !JSON.stringify(l).includes('get')));
});
test('second malformed response fails explicitly without leaking its text as a success', async t => {
  const { send, received } = await fixture(t, [completion(bad)]);
  const response = await send(); assert.equal(response.status, 502);
  const result = await response.json(); assert.equal(result.error.type, 'tool_call_recovery_error');
  assert.equal(received.length, 2); assert.ok(!JSON.stringify(result).includes('<run_kubectl'));
});
test('retries the observed whitespace-only stop instead of silently ending the conversation', async t => {
  const valid = completion(null, { calls: [call] });
  const { send, received, logs } = await fixture(t, [completion('\n\n'), valid]);
  assert.equal(await (await send()).text(), valid.body); assert.equal(received.length, 2);
  assert.equal(logs[0].reason, 'empty-answer');
});
test('a second empty completion fails explicitly', async t => {
  const { send, received } = await fixture(t, [completion('\n\n')]);
  assert.equal((await send()).status, 502); assert.equal(received.length, 2);
});
test('preserves an explicit silent-response marker', async t => {
  const value = completion('NO_REPLY'), { send, received } = await fixture(t, [value]);
  assert.equal(await (await send()).text(), value.body); assert.equal(received.length, 1);
});
test('does not replay already structured calls even when accompanied by invocation text', async t => {
  const value = completion(bad, { calls: [call] });
  const { send, received } = await fixture(t, [value]);
  assert.equal(await (await send()).text(), value.body); assert.equal(received.length, 1);
});
for (const [name, content] of [
  ['prose', 'The tool is currently unavailable.'],
  ['fenced example', 'Example:\n```text\n' + bad + '\n```'],
  ['quoted example', '> <run_kubectl args=["get", "nodes"]}'],
  ['unregistered tool', '<other_tool args=["get", "nodes"]}'],
]) test(`preserves ${name}`, async t => {
  const value = completion(content), { send, received } = await fixture(t, [value]);
  assert.equal(await (await send()).text(), value.body); assert.equal(received.length, 1);
});
for (const [name, extra] of [['none', { tool_choice: 'none' }], ['named', { tool_choice: { type: 'function', function: { name: 'run_kubectl' } } }],
  ['multiple choices', { n: 2 }], ['no tools', { tools: [] }]]) test(`leaves ${name} requests to existing transport`, async t => {
  const { send, received } = await fixture(t, [completion(bad)]);
  assert.equal((await send({ ...request, ...extra })).status, 204); assert.equal(received.length, 0);
});
test('preserves upstream HTTP errors without retry', async t => {
  const value = { status: 403, headers: { 'content-type': 'application/json' }, body: '{"error":"denied"}' };
  const { send, received } = await fixture(t, [value]); const r = await send();
  assert.equal(r.status, 403); assert.equal(await r.text(), value.body); assert.equal(received.length, 1);
});
test('rejects incomplete streams without a corrective generation', async t => {
  const { send, received } = await fixture(t, [completion(bad, { done: false })]);
  assert.equal((await send()).status, 502); assert.equal(received.length, 1);
});
test('enforces the response buffer limit', async t => {
  const { send, received } = await fixture(t, [completion('x'.repeat(4096))], { maxBytes: 1024 });
  assert.equal((await send()).status, 502); assert.equal(received.length, 1);
});
test('enforces one deadline across both requests', async t => {
  const { send, received } = await fixture(t, [{ ...completion(bad), delay: 40 }, { ...completion('ok'), delay: 100 }], { timeoutMs: 100 });
  const r = await send(); assert.equal(r.status, 502); assert.equal(received.length, 2);
});
test('can inspect compressed streams without rewriting a native provider response', async t => {
  const value = completion(null, { calls: [call] });
  const { send, received } = await fixture(t, [{ ...value, headers: { ...value.headers, 'content-encoding': 'gzip' }, body: gzipSync(value.body) }]);
  assert.equal(await (await send()).text(), value.body); assert.equal(received.length, 1);
});
test('a correction may explain a limitation without being forced to execute', async t => {
  const valid = completion('No authorized target was specified. Please identify the cluster.');
  const { send, received } = await fixture(t, [completion(bad), valid]);
  assert.equal(await (await send()).text(), valid.body); assert.equal(received.length, 2);
});
test('does not turn malformed arguments or shell syntax into executable calls', async t => {
  const malformed = '<run_kubectl args=["get", "pods", "--no-headers" | wc -l]}';
  const valid = completion('The supplied example is not valid tool arguments.');
  const { send, received } = await fixture(t, [completion(malformed), valid]);
  assert.equal(await (await send()).text(), valid.body);
  assert.ok(!JSON.stringify(received[1].messages).includes('| wc -l'));
  assert.ok(!received[1].messages.some(m => m.tool_calls || m.role === 'tool'));
});
