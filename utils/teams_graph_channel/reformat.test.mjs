// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {reformatRecordedAnswer} from './reformat.mjs';

test('format repair only patches the recorded service-account answer without calling a model',async()=>{
 const state={messages:{incoming:{state:'done',answer:'## Report\n\n**evidence**',receipts:[{id:'out'}]}}};
 const requests=[];let body={contentType:'text',content:state.messages.incoming.answer};
 const c={c:{senderId:'svc'},chatPath:()=>'/v1.0/chats/fixed',graph:async(url,method='GET',value)=>{
  requests.push({url,method,value});if(method==='PATCH'){body=value.body;return {};}
  return {id:'out',from:{user:{id:'svc'}},body};
 }};
 const result=await reformatRecordedAnswer(c,state,'out');
 assert.equal(result.changed,true);assert.equal(result.newMessageSent,false);assert.equal(result.modelInvoked,false);
 assert.deepEqual(requests.map(r=>r.method),['GET','PATCH','GET']);
 assert.equal(result.after.body.contentType,'html');
 assert.equal(state.messages.incoming.answer,'## Report\n\n**evidence**');
});

test('unrecorded messages, changed text and another sender cannot be reformatted',async()=>{
 const state={messages:{incoming:{state:'done',answer:'original',receipts:[{id:'out'}]}}};
 for(const sample of [{id:'out',from:{user:{id:'other'}},body:{contentType:'text',content:'original'}},
                     {id:'out',from:{user:{id:'svc'}},body:{contentType:'text',content:'changed'}}]){
  const c={c:{senderId:'svc'},chatPath:()=>'/v1.0/chats/fixed',graph:async(_url,method)=>{assert.equal(method,undefined);return sample;}};
  await assert.rejects(reformatRecordedAnswer(c,state,'out'));
  await assert.rejects(reformatRecordedAnswer(c,state,'unrecorded'));
 }
});
