// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

const SEARCH = 'opensearch_search';
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function readBody(stream, limit = Infinity) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let bytes = 0;
    stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > limit) {
        reject(new Error('Research response exceeds the compatibility buffer limit.'));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => resolveBody(Buffer.concat(chunks)));
    stream.on('error', reject);
    stream.on('aborted', () => reject(new Error('Upstream response ended before completion.')));
  });
}

function searchSchema(tools) {
  const tool = tools?.find?.(item => item.type === 'function' && item.function?.name === SEARCH);
  const parameters = tool?.function?.parameters;
  return parameters?.type === 'object'
    && parameters.properties?.query?.type === 'string'
    && Object.keys(parameters.properties).length === 1
    && parameters.required?.length === 1 && parameters.required[0] === 'query';
}

function prepare(method, path, raw, researchToolCalls) {
  if (method !== 'POST' || !path.endsWith('/chat/completions')) return { body: raw };
  let json;
  try { json = JSON.parse(raw.toString('utf8')); } catch { return { body: raw }; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return { body: raw };
  json.reasoning_effort = 'none';
  const research = searchSchema(json.tools);
  const named = json.tool_choice?.type === 'function' && json.tool_choice.function?.name === SEARCH;
  const automatic = json.tool_choice == null || json.tool_choice === 'auto';
  const initial = json.messages?.at?.(-1)?.role === 'user'
    && json.tools?.some?.(item => item.function?.name === 'task');
  const normalize = researchToolCalls && research && (json.n == null || json.n === 1)
    && (named || (automatic && initial));
  const stream = json.stream === true;
  if (normalize) {
    json.tool_choice = { type: 'function', function: { name: SEARCH } };
    json.chat_template_kwargs = { ...json.chat_template_kwargs, enable_thinking: false };
    // Some affected providers discard named arguments in their nonstream path.
    json.stream = true;
    if (!stream) json.stream_options = { ...json.stream_options, include_usage: true };
  }
  return { body: Buffer.from(JSON.stringify(json)), research, normalize, stream };
}

function decodeBody(raw, headers) {
  const encoding = String(headers['content-encoding'] || 'identity').toLowerCase();
  if (encoding === 'gzip') raw = gunzipSync(raw);
  else if (encoding === 'deflate') raw = inflateSync(raw);
  else if (encoding === 'br') raw = brotliDecompressSync(raw);
  else if (encoding !== 'identity') throw new Error('Unsupported upstream response encoding.');
  return textDecoder.decode(raw);
}

function validArguments(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error('Named research tool arguments are not complete JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 1 || typeof value.query !== 'string' || !value.query.trim()) {
    throw new Error('Named research tool arguments do not match the query-only schema.');
  }
}

function normalizeResponse(raw, headers, stream) {
  if (!String(headers['content-type']).includes('text/event-stream')) {
    throw new Error('Expected a streaming named research response.');
  }
  const events = [];
  let done = false;
  for (const frame of decodeBody(raw, headers).replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    if (data === '[DONE]') { done = true; continue; }
    const event = JSON.parse(data);
    if (event.error) throw new Error('Upstream reported an error in the research stream.');
    if (event.choices?.length > 1) throw new Error('Expected one research completion choice.');
    events.push(event);
  }
  const metadata = events.find(event => event.id && event.model);
  if (!done || !metadata) throw new Error('Research stream did not complete.');
  let content = '', reasoning = '', finish;
  const calls = new Map();
  for (const event of events) {
    const choice = event.choices?.[0];
    if (!choice) continue;
    if (choice.index !== 0) throw new Error('Unexpected research completion choice.');
    if (choice.finish_reason) finish = choice.finish_reason;
    const delta = choice.delta || {};
    content += delta.content || '';
    reasoning += delta.reasoning || delta.reasoning_content || '';
    for (const part of delta.tool_calls || []) {
      const value = calls.get(part.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (part.id) value.id = part.id;
      if (part.function?.name) value.function.name += part.function.name;
      if (part.function?.arguments) value.function.arguments += part.function.arguments;
      calls.set(part.index, value);
    }
  }
  if (!['stop', 'tool_calls'].includes(finish)) throw new Error('Research tool generation did not finish normally.');
  let call;
  const performed = calls.size === 0;
  if (calls.size) {
    if (calls.size !== 1 || calls.get(0)?.function.name !== SEARCH || !calls.get(0).id) {
      throw new Error('Upstream returned an unexpected research tool call.');
    }
    call = calls.get(0);
    validArguments(call.function.arguments);
    if (stream) return { body: raw, headers, performed: false, toolCallId: call.id };
  } else {
    validArguments(content);
    call = { id: `call_research_${randomUUID().replaceAll('-', '')}`, type: 'function', function: { name: SEARCH, arguments: content } };
    content = '';
  }
  const usage = events.findLast(event => event.usage)?.usage;
  const meta = { id: metadata.id, created: metadata.created, model: metadata.model };
  if (!stream) {
    const message = { role: 'assistant', content: content || null, tool_calls: [call] };
    if (reasoning) message.reasoning = reasoning;
    const value = { ...meta, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'tool_calls' }], usage: usage || null };
    return { body: Buffer.from(JSON.stringify(value)), headers: { 'content-type': 'application/json' }, performed, toolCallId: call.id };
  }
  const first = { role: 'assistant', content: '' };
  if (reasoning) first.reasoning = reasoning;
  const chunks = [first, { tool_calls: [{ index: 0, ...call }] }, {}].map((delta, index) => ({
    ...meta, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: index === 2 ? 'tool_calls' : null }],
  }));
  if (usage) chunks.push({ ...meta, object: 'chat.completion.chunk', choices: [], usage });
  const body = Buffer.from(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
  return { body, headers: { 'content-type': 'text/event-stream' }, performed, toolCallId: call.id };
}

function sendBody(res, status, headers, body) {
  const output = { ...headers, 'content-length': String(body.length) };
  delete output['transfer-encoding'];
  res.writeHead(status, output).end(body);
}

export function createCompatibilityServer({ upstreamBaseUrl, researchToolCalls = false, auditDirectory = '', timeoutMs = 180_000, maxBufferedBytes = 16 * 1024 * 1024, log = () => {} }) {
  const upstream = new URL(upstreamBaseUrl);
  if (!['http:', 'https:'].includes(upstream.protocol) || upstream.username || upstream.password) throw new Error('Invalid upstream URL.');
  async function audit(id, record) {
    if (!auditDirectory) return;
    await mkdir(auditDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(auditDirectory, `${id}.json`), JSON.stringify(record, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  return http.createServer(async (req, res) => {
    if (req.url === '/health') return res.writeHead(200).end('ok');
    const id = randomUUID();
    let record, audited = false;
    try {
      const target = new URL(req.url, upstream);
      if (target.origin !== upstream.origin) throw new Error('Request must use the configured upstream.');
      const original = await readBody(req);
      const prepared = prepare(req.method, target.pathname, original, researchToolCalls);
      const shouldAudit = researchToolCalls && prepared.research && Boolean(auditDirectory);
      if (shouldAudit) record = { id, at: new Date().toISOString(), originalRequestBase64: original.toString('base64'), forwardedRequestBase64: prepared.body.toString('base64'), headersExcluded: 'Authentication and cookie headers are never recorded.' };
      const headers = { ...req.headers, host: target.host, 'content-length': String(prepared.body.length) };
      delete headers['transfer-encoding'];
      if (prepared.normalize) headers['accept-encoding'] = 'identity';
      const client = target.protocol === 'https:' ? https : http;
      await new Promise((resolveRequest, reject) => {
        const out = client.request(target, { method: req.method, headers }, async response => {
          try {
            if (!prepared.normalize && !shouldAudit) {
              res.writeHead(response.statusCode || 502, response.headers);
              response.on('error', reject);
              response.on('end', resolveRequest);
              response.pipe(res);
              return;
            }
            const raw = await readBody(response, maxBufferedBytes);
            if (record) Object.assign(record, { upstreamStatus: response.statusCode, upstreamResponseBase64: raw.toString('base64'), upstreamContentType: response.headers['content-type'], upstreamContentEncoding: response.headers['content-encoding'], upstreamResponseComplete: true });
            let output = { body: raw, headers: response.headers, performed: false };
            if (prepared.normalize && response.statusCode === 200) output = normalizeResponse(raw, response.headers, prepared.stream);
            if (record) {
              Object.assign(record, { normalizationPerformed: output.performed, toolCallId: output.toolCallId, returnedResponseBase64: output.body.toString('base64') });
              await audit(id, record); audited = true;
            }
            if (output.performed) log({ event: 'research-tool-normalized', requestId: id, toolCallId: output.toolCallId, upstreamBytes: raw.length, returnedBytes: output.body.length });
            sendBody(res, response.statusCode || 502, output.headers, output.body);
            resolveRequest();
          } catch (error) { reject(error); }
        });
        if (prepared.normalize || shouldAudit) out.setTimeout(timeoutMs, () => out.destroy(new Error('Research upstream request timed out.')));
        out.on('error', reject);
        out.end(prepared.body);
      });
    } catch (error) {
      if (record && !audited) {
        try { await audit(id, { ...record, error: String(error.message), returnedSuccess: false }); }
        catch { /* The failed response below does not claim successful auditing. */ }
      }
      if (res.headersSent) return res.destroy();
      sendBody(res, 502, { 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ error: { message: String(error.message), type: 'research_tool_compatibility_error', request_id: id } })));
    }
  });
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  createCompatibilityServer({
    upstreamBaseUrl: process.env.UPSTREAM_BASE_URL,
    researchToolCalls: process.env.RESEARCH_TOOL_CALLS_ENABLED === 'true',
    auditDirectory: process.env.RESEARCH_TOOL_CALLS_AUDIT_DIR || '',
    log: value => console.log(JSON.stringify(value)),
  }).listen(Number(process.env.PORT || 8000), '0.0.0.0');
}
