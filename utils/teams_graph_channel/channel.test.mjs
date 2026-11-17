// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Channel, completedAnswer, plainText, chunks, validateConfig} from './channel.mjs';
const now=Date.parse('2026-11-17T08:00:00Z');
const cfg={chatId:'fixed',senderId:'svc',recipientId:'jeff',senderUpn:'svc@example.com',
 sessionKey:'agent:default:mosaic-automation-alert-teams-test',mosaicUrl:'http://mosaic-ui:3000',
 credentialFile:'/unused',machineTokenFile:'/unused',stateDir:'/unused',pollSeconds:10};
const msg=(id,who,at,text)=>({id,from:{user:{id:who}},createdDateTime:new Date(at).toISOString(),
 messageType:'message',body:{contentType:'html',content:'<p>'+text+'</p>'}});
async function setup(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'mosaic-teams-test-'));
 t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const c=new Channel({...cfg,stateDir:dir},{now:()=>now});
 c.state={version:1,chatId:'fixed',sessionKey:cfg.sessionKey,activatedAt:new Date(now-60000).toISOString(),
 cursor:new Date(now-60000).toISOString(),messages:{}};
 c.event=async()=>{}; return c;
}
test('config requires an immutable read-only automation session',()=>{
 assert.doesNotThrow(()=>validateConfig(cfg));
 assert.throws(()=>validateConfig({...cfg,sessionKey:'agent:default:main'}));
 assert.throws(()=>validateConfig({...cfg,senderId:'jeff'}));
});
test('HTML conversion and Unicode chunking preserve content without byte overflow',()=>{
 assert.equal(plainText({contentType:'html',content:'<p>你好 &amp; Xid</p><p>&#x1F600;</p>'}),'你好 & Xid\n😀');
 const text='中😀abcd'.repeat(10000), parts=chunks(text);
 assert.equal(parts.join(''),text); assert.ok(parts.every(p=>Buffer.byteLength(p)<=18000));
});
test('completion must belong to this prompt and a normally completed assistant turn',()=>{
 const h={hasActiveRun:false,messages:[{role:'user',content:'id-1 question'},{role:'assistant',content:[{type:'text',text:'回答'}],stopReason:'stop'}]};
 assert.equal(completedAnswer(h,'id-1 question'),'回答');
 assert.equal(completedAnswer(h,'id-2 question'),null);
 assert.equal(completedAnswer({...h,hasActiveRun:true},'id-1 question'),null);
 assert.throws(()=>completedAnswer({...h,messages:[h.messages[0],{...h.messages[1],stopReason:'length'}]},'id-1 question'));
});
test('poll follows pagination, ignores history, own messages and non-allowed users; deduplicates restarts',async t=>{
 const c=await setup(t); let page=0;
 c.graph=async()=>++page%2 ? {value:[msg('own','svc',now-1000,'bot'),msg('foreign','other',now-1500,'no'),msg('new','jeff',now-2000,'你好')],'@odata.nextLink':'https://graph.microsoft.com/v1.0/chats/fixed/messages?page=2'}:
 {value:[msg('older','jeff',now-10000,'先问'),msg('history','jeff',now-120000,'old')]};
 await c.poll(); assert.deepEqual(Object.keys(c.state.messages),['older','new']);
 const saved=JSON.parse(await fs.readFile(c.statePath)); c.state=saved;
 await c.poll(); assert.deepEqual(Object.keys(c.state.messages),['older','new']);
});
test('one incoming message automatically submits once, preserves full answer and saves receipt',async t=>{
 const c=await setup(t), row={id:'new',state:'queued',prompt:'message new question',receipts:[]}; c.state.messages.new=row;
 let submits=0,sends=0; c.mosaic=async()=>{submits++;return {success:true,runId:'run1'};};
 c.history=async()=>({hasActiveRun:false,messages:[{role:'user',content:row.prompt},{role:'assistant',content:'自动回答',stopReason:'stop'}]});
 c.graph=async(_p,method,b)=>{assert.equal(method,'POST');assert.equal(b.body.contentType,'html');assert.equal(b.body.content,'<p>自动回答</p>');sends++;return {id:'reply1'};};
 await c.process(row); await c.process(row);
 assert.equal(submits,1);assert.equal(sends,1);assert.equal(row.state,'done');assert.equal(row.runId,'run1');
 assert.equal(row.receipts[0].id,'reply1');
});
test('ambiguous agent submission recovers from history without submitting a second turn',async t=>{
 const c=await setup(t),row={id:'r',state:'running',prompt:'recover',startedAt:new Date(now-10000).toISOString(),receipts:[]};c.state.messages.r=row;
 c.mosaic=async()=>assert.fail('must not submit a running turn');
 c.history=async()=>({hasActiveRun:false,messages:[{role:'user',content:'recover'},{role:'assistant',content:'recovered'}]});
 c.graph=async()=>({id:'reply2'}); await c.process(row);assert.equal(row.state,'done');
});
test('ambiguous outgoing send persists intent and never duplicates on restart',async t=>{
 const c=await setup(t),row={id:'r',state:'ready',parts:['answer'],receipts:[]};c.state.messages.r=row;
 let sends=0;c.graph=async()=>{sends++;throw new Error('network_timeout');};
 await c.process(row);assert.equal(row.state,'send_uncertain');
 c.state=JSON.parse(await fs.readFile(c.statePath));await c.process(c.state.messages.r);assert.equal(sends,1);
});
test('webhook accepts only matching firing simulations and deduplicates redelivery',async t=>{
 const c=await setup(t);c.c.webhook={matchLabels:{teams_validation:'true',simulation:'true'}};
 const alert={status:'firing',fingerprint:'a123',startsAt:new Date(now).toISOString(),labels:{run_id:'teams-xid-test',teams_validation:'true',simulation:'true'}};
 assert.equal((await c.ingestAlerts({alerts:[alert]}))[0].duplicate,false);
 assert.equal((await c.ingestAlerts({alerts:[alert]}))[0].duplicate,true);
 assert.deepEqual(await c.ingestAlerts({alerts:[{...alert,status:'resolved'},{...alert,labels:{...alert.labels,simulation:'false'}}]}),[]);
 const row=Object.values(c.state.messages)[0];assert.equal(row.kind,'alert');assert.match(row.prompt,/IRAOP/);
 assert.equal(Object.keys(c.state.messages).length,1);
});
test('concurrent webhook and poll writes keep valid durable state',async t=>{
 const c=await setup(t);c.state.messages.a={id:'a'};const a=c.save();c.state.messages.b={id:'b'};const b=c.save();
 await Promise.all([a,b]);assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(c.statePath)).messages),['a','b']);
});
