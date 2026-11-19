// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const http = require('node:http');
const https = require('node:https');
const { gunzipSync, inflateSync, brotliDecompressSync } = require('node:zlib');

const CORRECTION = 'A candidate response was discarded because it was empty or contained tool-invocation markup as ordinary text, '
  + 'but no structured tool call was returned and nothing in that response was executed. '
  + 'Continue the original user request. If an authorized operation is needed, use the provided '
  + 'function-calling interface; do not print invocation markup as an answer. Do not invent results, '
  + 'change targets, expand authorization, or repeat operations already completed or denied for this request. '
  + 'Use existing tool results when they already answer the request. If the user asked for an '
  + 'example or explanation, answer that request and put any literal invocation examples in a fenced '
  + 'code block. If no tool is appropriate, give an ordinary answer explaining the limitation.';

function invocationText(content, names) {
  // Literal code examples and quoted lines are not execution requests.
  const prose = content.replace(/```[^]*?```|~~~[^]*?~~~/g, '').replace(/^\s*>.*$/gm, '');
  return names.some(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^\\s*<${escaped}\\s+[A-Za-z_][\\w-]*\\s*=`, 'm').test(prose)
      || new RegExp(`^\\s*<(?:tool_call|function)[^\\n]*${escaped}(?=[\\s="'>])`, 'm').test(prose);
  });
}

function completionJson(text) {
  try { return JSON.parse(text); } catch { throw new Error('Completion contains invalid JSON.'); }
}

function inspectResponse(raw, headers, limit) {
  const encoding = String(headers['content-encoding'] || 'identity').toLowerCase();
  const options = { maxOutputLength: limit };
  if (encoding === 'gzip') raw = gunzipSync(raw, options);
  else if (encoding === 'deflate') raw = inflateSync(raw, options);
  else if (encoding === 'br') raw = brotliDecompressSync(raw, options);
  else if (encoding !== 'identity') throw new Error('Unsupported completion encoding.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  if (!String(headers['content-type']).includes('text/event-stream')) {
    const value = completionJson(text);
    if (value.error || value.choices?.length !== 1) throw new Error('Unexpected completion response.');
    const choice = value.choices[0];
    return { content: typeof choice.message?.content === 'string' ? choice.message.content : '',
      calls: choice.message?.tool_calls?.length || (choice.message?.function_call ? 1 : 0), finish: choice.finish_reason };
  }
  let content = '', calls = 0, done = false, finish;
  for (const frame of text.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    if (data === '[DONE]') { done = true; continue; }
    const value = completionJson(data);
    if (value.error || value.choices?.length > 1) throw new Error('Unexpected completion stream.');
    for (const choice of value.choices || []) {
      if (choice.index !== 0) throw new Error('Unexpected completion choice.');
      content += choice.delta?.content || '';
      calls += choice.delta?.tool_calls?.length || (choice.delta?.function_call ? 1 : 0);
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  if (!done || !finish) throw new Error('Completion stream ended before its final event.');
  return { content, calls, finish };
}

function collect(target, method, headers, body, signal, limit) {
  return new Promise((resolve, reject) => {
    const requestHeaders = { ...headers, host: target.host, 'content-length': String(body.length), 'accept-encoding': 'identity' };
    delete requestHeaders['transfer-encoding'];
    const client = target.protocol === 'https:' ? https : http;
    const request = client.request(target, { method, headers: requestHeaders, signal }, response => {
      const parts = []; let bytes = 0;
      response.on('data', part => {
        bytes += part.length;
        if (bytes > limit) {
          reject(new Error('Completion exceeds the recovery buffer limit.'));
          response.destroy(); request.destroy(); return;
        }
        parts.push(part);
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Completion response was interrupted.')));
      response.on('end', () => resolve({ status: response.statusCode || 502, headers: response.headers, body: Buffer.concat(parts) }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function send(res, result) {
  const headers = { ...result.headers, 'content-length': String(result.body.length) };
  delete headers['transfer-encoding'];
  res.writeHead(result.status, headers).end(result.body);
}

/** Return false for ineligible requests so the existing proxy handles them unchanged. */
async function recoverToolCallText({ req, res, target, body, timeoutMs = 180000, maxBytes = 16 * 1024 * 1024, log = () => {} }) {
  if (req.method !== 'POST' || !target.pathname.endsWith('/chat/completions')) return false;
  let request;
  try { request = JSON.parse(body.toString('utf8')); } catch { return false; }
  const names = Array.isArray(request?.tools) ? request.tools.filter(t => t?.type === 'function')
    .map(t => t.function?.name).filter(n => typeof n === 'string' && n) : [];
  if (!names.length || !Array.isArray(request.messages) || (request.n != null && request.n !== 1)
    || (request.tool_choice != null && request.tool_choice !== 'auto')) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const closed = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', closed);
  try {
    let result = await collect(target, req.method, req.headers, body, controller.signal, maxBytes);
    if (result.status === 200) {
      const first = inspectResponse(result.body, result.headers, maxBytes);
      if (!first.calls && (!first.content.trim() || invocationText(first.content, names))) {
        if (first.finish !== 'stop') throw new Error('Tool-invocation text was not a completed generation.');
        log({ event: 'tool-call-text-retry', reason: first.content.trim() ? 'invocation-text' : 'empty-answer' });
        // Do not teach the model to imitate the malformed candidate or insert a fake user request.
        // Some serving templates require system messages to be first.
        const messages = [...request.messages];
        if (messages[0]?.role === 'system' && typeof messages[0].content === 'string') {
          messages[0] = { ...messages[0], content: messages[0].content + '\n\n' + CORRECTION };
        } else if (messages[0]?.role === 'system' && Array.isArray(messages[0].content)) {
          messages[0] = { ...messages[0], content: [...messages[0].content, { type: 'text', text: CORRECTION }] };
        } else messages.unshift({ role: 'system', content: CORRECTION });
        const corrected = { ...request, messages };
        result = await collect(target, req.method, req.headers, Buffer.from(JSON.stringify(corrected)), controller.signal, maxBytes);
        if (result.status === 200) {
          const second = inspectResponse(result.body, result.headers, maxBytes);
          if (!second.calls && invocationText(second.content, names)) throw new Error('Model returned tool-invocation text again; no tool was executed by the proxy.');
          if (!['stop', 'tool_calls', 'function_call'].includes(second.finish)) throw new Error('Corrected generation did not complete.');
          if (!second.calls && !second.content.trim()) throw new Error('Corrected generation contained no visible answer or tool call.');
          log({ event: 'tool-call-text-recovered', structuredCalls: second.calls > 0 });
        }
      }
    }
    if (!res.destroyed) send(res, result);
  } catch (error) {
    log({ event: 'tool-call-text-error', reason: error.name === 'AbortError' ? 'timeout-or-disconnect' : error.message });
    if (!res.destroyed && !res.headersSent) send(res, { status: 502, headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ error: { type: 'tool_call_recovery_error', message: error.name === 'AbortError'
        ? 'Tool-call recovery timed out.' : error.message } })) });
  } finally {
    clearTimeout(timer); res.off('close', closed);
  }
  return true;
}

module.exports = { recoverToolCallText };
