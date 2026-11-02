// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// Live test: run only against an isolated deployment with shared memory enabled.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';

const root=process.env.MOSAIC_TEST_URL?.replace(/\/$/,'');
assert.ok(root && process.env.MOSAIC_TEST_USERNAME && process.env.MOSAIC_TEST_PASSWORD,
  'Set MOSAIC_TEST_URL, MOSAIC_TEST_USERNAME and MOSAIC_TEST_PASSWORD for the isolated test instance.');
const authorization='Basic '+Buffer.from(process.env.MOSAIC_TEST_USERNAME+':'+process.env.MOSAIC_TEST_PASSWORD).toString('base64');
async function api(path,body){
  const response=await fetch(root+path,{method:body?'POST':'GET',headers:{authorization,'content-type':'application/json'},
    ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(300000)});
  assert.ok(response.ok,`Test API returned ${response.status}`);
  const text=await response.text();
  if(path.endsWith('/stream')){
    const events=text.split('\n').filter(Boolean).map(line=>JSON.parse(line));
    assert.deepEqual(events.filter(event=>event.type==='error'),[],'Chat emitted a stream error');
    return events;
  }
  return JSON.parse(text);
}
const fixture=process.env.MEMORY_TEST_RECALL_FROM
  ? JSON.parse(readFileSync(process.env.MEMORY_TEST_RECALL_FROM,'utf8')).fixture
  : {workshop: 'workshop-'+randomUUID().slice(0,8), combination: String(Math.floor(Math.random()*900000)+100000)};
const session=()=> 'agent:default:memory-validation-'+randomUUID();
const sourceSessionKey=session();
const sessionKey=session();
if(process.env.MEMORY_TEST_EVIDENCE)writeFileSync(process.env.MEMORY_TEST_EVIDENCE,JSON.stringify({fixture,sourceSessionKey,sessionKey},null,2));
if(!process.env.MEMORY_TEST_RECALL_FROM){
  await api('/api/openclaw/chat/stream',{sessionKey:sourceSessionKey,
    prompt:`For fictional ${fixture.workshop}, the delivery locker combination is ${fixture.combination}. Acknowledge this.`});
}
await api('/api/openclaw/chat/stream',{sessionKey,
  prompt:`Look through our other conversations: which combination did I give you for deliveries at ${fixture.workshop}?`});
const history=await api('/api/openclaw/chat?sessionKey='+encodeURIComponent(sessionKey)+'&limit=1000');
const messages=JSON.parse(history.history.stdout).messages;
const retrievals=messages.filter(message=>message.role==='toolResult' &&
  ['memory_search','sessions_history'].includes(message.toolName));
assert.ok(retrievals.length,'Recall did not retrieve saved conversation evidence');
assert.ok(retrievals.some(message=>JSON.stringify(message.content).includes(fixture.combination)),
  'Retrieved evidence did not contain the independently stored fact');
const answer=history.messages.filter(message=>message.role==='assistant').at(-1)?.content||'';
assert.ok(answer.includes(fixture.combination),'Answer did not recall the earlier short fact');
const evidence={fixture,sourceSessionKey,sessionKey,retrievals:retrievals.map(message=>message.toolName),answer};
if(process.env.MEMORY_TEST_EVIDENCE)writeFileSync(process.env.MEMORY_TEST_EVIDENCE,JSON.stringify(evidence,null,2));
console.log('Recalled a short fact from a separate conversation using saved evidence.');
