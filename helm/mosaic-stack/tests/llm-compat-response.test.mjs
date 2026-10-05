// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import response from '../files/llm-compat-response.cjs';
const {separateReasoning, completionEvents} = response;
const completion = message => ({id:'request', model:'model', choices:[{index:0, message, finish_reason:'stop'}]});

test('keeps analysis out of final content without rewriting the answer', () => {
  for (const prefix of ['', '<think>']) {
    const result = separateReasoning(completion({role:'assistant', content:prefix+'Private analysis</think>\nThe service is ready.'}), '</think>');
    assert.equal(result.choices[0].message.content, '\nThe service is ready.');
    assert.equal(result.choices[0].message.reasoning_content, 'Private analysis');
  }
});
test('preserves native reasoning and tool call arguments', () => {
  const tool_calls = [{id:'call', type:'function', function:{name:'inspect', arguments:'{"scope":"sample"}'}}];
  const input = completion({role:'assistant', content:null, reasoning_content:'Analysis', tool_calls});
  const result = separateReasoning(input, '</think>');
  assert.deepEqual(result, input);
  const event = JSON.parse(completionEvents(result).split('\n')[0].slice(6));
  assert.deepEqual(event.choices[0].delta.tool_calls[0], {...tool_calls[0], index:0});
  assert.equal(event.choices[0].delta.reasoning_content, 'Analysis');
});
test('fails closed when a configured reasoning boundary is missing', () => {
  assert.throws(() => separateReasoning(completion({content:'Unfinished analysis'}), '</think>'));
});
test('keeps pre-tool analysis separate when no final answer exists', () => {
  const tool_calls = [{id:'c', type:'function', function:{name:'read', arguments:'{}'}}];
  const result = separateReasoning(completion({content:'Inspect first', tool_calls}), '</think>');
  assert.equal(result.choices[0].message.content, null);
  assert.equal(result.choices[0].message.reasoning_content, 'Inspect first');
  assert.deepEqual(result.choices[0].message.tool_calls, tool_calls);
});
