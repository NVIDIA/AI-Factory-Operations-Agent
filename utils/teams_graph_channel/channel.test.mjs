// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Channel, completedAnswer, plainText, chunks, validateConfig, groupSessionKey, groupMessageInput} from './channel.mjs';
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

const svc='22222222-2222-2222-2222-222222222222', user='33333333-3333-3333-3333-333333333333';
const other='44444444-4444-4444-4444-444444444444';
const groupConfig={...cfg,chatType:'group',chatId:'group-chat',senderId:svc,recipientId:undefined,
 allowedUserIds:[user],requireMention:true,sessionKey:groupSessionKey('group-chat')};
const groupMessage=(id, who=user)=>({...msg(id,who,now-1000,'<at id="0">Service</at> explain Xid'),
 mentions:[{id:0,mentioned:{user:{id:svc}}}]});
const receiptId = '1700000000001';
const quoteMessage = (id, at, who = user, targetId = receiptId) => ({
 ...msg(id,who,at,`<attachment id="${targetId}"></attachment><p>Separate agents and services.</p>`),
 chatId:groupConfig.chatId, replyToId:null, mentions:[],
 attachments:[{id:targetId,contentType:'messageReference',content:JSON.stringify({
  messageId:targetId,messageSender:{user:{id:svc}},messagePreview:'An abbreviated preview.',
 })}],
});
const mosaicReceipt = {
 id:receiptId,chatId:groupConfig.chatId,from:{user:{id:svc}},
 body:{contentType:'html',content:'<p>The prior full answer in this group.</p>'},
};
function recordReply(c) {
 c.state.messages.previous = {id:'previous',state:'done',createdAt:new Date(now-2000).toISOString(),
  receipts:[mosaicReceipt]};
}
async function setupGroup(t) {
 const c=await setup(t);c.c=validateConfig({...groupConfig,stateDir:c.c.stateDir});
 c.state.chatType='group';c.state.chatId=c.c.chatId;c.state.sessionKey=c.c.sessionKey;
 return c;
}
test('groups require exact chat-derived session, explicit user IDs and mandatory mentions',()=>{
 assert.doesNotThrow(()=>validateConfig(groupConfig));
 for (const delta of [{allowedUserIds:[]},{allowedUserIds:['*']},{allowedUserIds:[svc]},
  {allowedUserIds:[user,user]},{requireMention:false},{webhook:{}},{sessionKey:cfg.sessionKey},
  {chatId:'different-group'}, {chatType:'meeting'}]) {
  assert.throws(()=>validateConfig({...groupConfig,...delta}));
 }
 assert.notEqual(groupSessionKey('group-chat'),groupSessionKey('other-chat'));
 assert.throws(()=>validateConfig({...cfg,sessionKey:groupSessionKey('group-chat')}));
 assert.throws(()=>validateConfig({...cfg,allowQuotedReplies:true}),/invalid_quoted_replies_config/);
 assert.throws(()=>validateConfig({...groupConfig,allowQuotedReplies:'true'}),/invalid_quoted_replies_config/);
});
test('group mentions require both structured service identity and matching HTML marker',()=>{
 const m=groupMessage('a');assert.equal(groupMessageInput(m,svc),'explain Xid');
 for (const bad of [{...m,mentions:[]},{...m,mentions:[{id:0,mentioned:{user:{id:other}}}]},
  {...m,mentions:[{id:1,mentioned:{user:{id:svc}}}]},
  {...m,body:{contentType:'html',content:'@Service explain Xid'}},
  {...m,body:{contentType:'text',content:'@Service explain Xid'}}]) assert.equal(groupMessageInput(bad,svc),null);
});
test('group polling checks paginated members and only queues allowed human mentions once',async t=>{
 const c=await setupGroup(t);let membershipPages=0;
 c.graph=async p=>{
  if(p===c.chatPath())return {id:c.c.chatId,chatType:'group'};
  if(p.endsWith('/members')){membershipPages++;return {value:[{userId:svc}], '@odata.nextLink':'https://graph.microsoft.com/v1.0/chats/group-chat/members?page=2'};}
  if(p.endsWith('members?page=2')){membershipPages++;return {value:[{userId:user},{userId:other}]};}
  return {value:[groupMessage('accepted'),groupMessage('unlisted',other),groupMessage('own',svc),
   {...groupMessage('unmentioned'),mentions:[]},groupMessage('nonmember','55555555-5555-5555-5555-555555555555'),
   {...groupMessage('old'),createdDateTime:new Date(now-120000).toISOString()},
   {...groupMessage('deleted'),deletedDateTime:new Date(now).toISOString()}]};
 };
 await c.poll();await c.poll();assert.equal(membershipPages,4);
 assert.deepEqual(Object.keys(c.state.messages),['accepted']);
 assert.equal(c.state.messages.accepted.input,'explain Xid');
 assert.match(c.state.messages.accepted.prompt,/shared group conversation/);
 assert.match(c.state.messages.accepted.prompt,new RegExp(user));
});
test('wrong chat type, absent service or broken member pagination stop group polling',async t=>{
 for (const scenario of ['wrong-type','absent-service','bad-page','pagination-loop']) {
  const c=await setupGroup(t);let reads=0;
  c.graph=async p=>{
   if(p===c.chatPath())return {id:c.c.chatId,chatType:scenario==='wrong-type'?'oneOnOne':'group'};
   if(p.includes('/members'))return scenario==='bad-page'?{}:
    {value:[{userId:scenario==='absent-service'?user:svc}],
     ...(scenario==='pagination-loop'?{'@odata.nextLink':p}:{})};
   reads++;return {value:[groupMessage('a')]};
  };
  await assert.rejects(()=>c.poll());assert.equal(reads,0);assert.deepEqual(c.state.messages,{});
 }
});
test('group answer stays in its own View session and chat, without manual relay',async t=>{
 const c=await setupGroup(t);let sends=0,submits=0;
 c.graph=async(p,method,body)=>{
  if(p===c.chatPath())return {id:c.c.chatId,chatType:'group'};
  if(p.endsWith('/members'))return {value:[{userId:svc},{userId:user}]};
  if(method==='POST') {assert.equal(p,c.chatPath()+'/messages');assert.equal(body.body.contentType,'html');sends++;return {id:'group-answer'};}
  return {value:[groupMessage('question')]};
 };
 c.mosaic=async(p,body)=>{assert.equal(p,'/api/headless/chat');assert.equal(body.sessionKey,groupSessionKey('group-chat'));
  assert.equal(body.accessMode,'view');submits++;return {runId:'group-run'};};
 c.history=async()=>({hasActiveRun:false,messages:[{role:'user',content:c.state.messages.question.prompt},
  {role:'assistant',content:'回答',stopReason:'stop'}]});
 await c.tick();await c.tick();assert.equal(submits,1);assert.equal(sends,1);
 assert.equal(c.state.messages.question.state,'done');
});
test('revoked group sender is not submitted; removal during investigation suppresses the answer',async t=>{
 for (const during of [false,true]) {
  const c=await setupGroup(t);let member=true,submits=0,sends=0;
  c.graph=async(p,method)=>{
   if(p===c.chatPath())return {id:c.c.chatId,chatType:'group'};
   if(p.endsWith('/members'))return {value:[{userId:svc},...(member?[{userId:user}]:[])]};
   if(method==='POST'){sends++;return {id:'should-not-send'};}
   return {value:[groupMessage('a')]};
  };
  await c.poll();if(!during)c.c.allowedUserIds=[other];
  c.mosaic=async()=>{submits++;member=false;return {runId:'r'};};
  c.history=async()=>({hasActiveRun:false,messages:[{role:'user',content:c.state.messages.a.prompt},
   {role:'assistant',content:'private result',stopReason:'stop'}]});
  await c.process(c.state.messages.a);
  assert.equal(submits,during?1:0);assert.equal(sends,0);assert.equal(c.state.messages.a.state,'failed');
 }
});
test('group worker cannot reuse a private-chat state directory',async t=>{
 const c=await setup(t);await c.save();
 const group=new Channel({...groupConfig,stateDir:c.c.stateDir});
 group.login=async()=>assert.fail('state mismatch must fail before login');
 await assert.rejects(()=>group.init(),/state_binding_mismatch/);
});

test('quote trigger requires an opt-in, live body reference and a confirmed reply in this chat',async t=>{
 const c = await setupGroup(t);
 const quote = quoteMessage('followup',now);
 recordReply(c);
 assert.equal(c.groupTrigger(quote),null);
 c.c.allowQuotedReplies = true;
 c.state.quotedRepliesActivatedAt = new Date(now).toISOString();
 assert.deepEqual(c.groupTrigger(quote),{kind:'quote',input:'Separate agents and services.',
  quotedMessageId:receiptId,quotedText:'The prior full answer in this group.'});
 const ref = quote.attachments[0];
 for (const invalid of [
  quoteMessage('unknown-target',now,user,'1700000000002'),
  {...quote,chatId:'different-chat'},
  {...quote,attachments:[{...ref,contentType:'forwardedMessageReference'}]},
  {...quote,attachments:[{...ref,content:'malformed JSON'}]},
  {...quote,attachments:[{...ref,content:JSON.stringify({messageId:receiptId,messageSender:{user:{id:other}}})}]},
  {...quote,body:{contentType:'html',content:'<p>Service said something.</p>'}},
  {...quote,body:{contentType:'html',content:`<attachment id="${receiptId}"></attachment>`}},
 ]) assert.equal(c.groupTrigger(invalid),null);
 c.state.messages.previous.receipts = [{...mosaicReceipt,chatId:'different-chat'}];
 assert.equal(c.groupTrigger(quote),null);
 c.state.messages.previous.receipts = [{...mosaicReceipt,from:{user:{id:other}}}];
 assert.equal(c.groupTrigger(quote),null);
});

test('group upgrade accepts new quotes once in the existing View session and ignores earlier quotes',async t=>{
 const old = await setupGroup(t);
 recordReply(old);
 await old.save();
 const machineTokenFile = path.join(old.c.stateDir,'fixture-token');
 await fs.writeFile(machineTokenFile,'fixture');
 const config = {...old.c,machineTokenFile,allowQuotedReplies:true};
 const newQuote = quoteMessage('new-quote',now+500);
 const oldQuote = quoteMessage('old-quote',now-500);
 const unlisted = quoteMessage('unlisted-quote',now+500,other);
 let submits = 0, sends = 0;
 const open = async at => {
  const c = new Channel(config,{now:()=>at});
  c.event = async()=>{};
  c.login = async()=>{};
  c.graph = async(p,method,body)=>{
   if(p==='/v1.0/me') return {id:svc,userPrincipalName:config.senderUpn};
   if(p===c.chatPath()) return {id:c.c.chatId,chatType:'group'};
   if(p.endsWith('/members')) return {value:[{userId:svc},{userId:user},{userId:other}]};
   if(method==='POST') {
    assert.equal(p,c.chatPath()+'/messages');
    assert.equal(body.body.contentType,'html');
    sends++;
    return {...mosaicReceipt,id:'1700000000003'};
   }
   return {value:[newQuote,oldQuote,unlisted]};
  };
  c.mosaic = async(p,body)=>{
   if(p==='/api/openclaw/commands') return {};
   assert.equal(p,'/api/headless/chat');
   assert.equal(body.sessionKey,groupConfig.sessionKey);
   assert.equal(body.accessMode,'view');
   assert.match(body.prompt,/The prior full answer in this group\./);
   assert.match(body.prompt,/Separate agents and services\./);
   assert.doesNotMatch(body.prompt,/An abbreviated preview\./);
   submits++;
   return {runId:'quote-run'};
  };
  c.history = async()=>({hasActiveRun:false,messages:[
   {role:'user',content:c.state.messages['new-quote'].prompt},
   {role:'assistant',content:'Agents and services listed separately.',stopReason:'stop'},
  ]});
  await c.init();
  return c;
 };
 const c = await open(now);
 await c.poll();
 assert.deepEqual(Object.keys(c.state.messages),['previous','new-quote']);
 assert.equal(c.state.messages['new-quote'].trigger,'quote');
 assert.equal(c.state.messages['new-quote'].quotedMessageId,receiptId);
 const restarted = await open(now+2000);
 assert.equal(restarted.state.quotedRepliesActivatedAt,new Date(now).toISOString());
 await restarted.tick();
 await restarted.tick();
 assert.equal(restarted.state.messages['new-quote'].state,'done');
 assert.equal(submits,1);
 assert.equal(sends,1);
});
