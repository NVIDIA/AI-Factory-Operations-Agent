// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {Bridge, chunks, completedAnswer, validateConfig} from './slack_dm_bridge/bridge.mjs';
import {Clients, credential, socketLoop, socketUrl, TransportError} from './slack_dm_bridge/transport.mjs';
import {Store} from './slack_dm_bridge/store.mjs';
import {isReadonlyAutomationSession, sessionAllowsEdit} from '../helm/mosaic-stack/files/openclaw-seed/extensions/automation-context.ts';

const config = {teamId:'T01234567',appId:'A01234567',botUserId:'U01234567',allowedUserIds:['U12345678','U23456789'],
  mosaicUrl:'http://mosaic-ui:3000',credentialsFile:'/unused/credentials.json',stateDir:'/unused/state',port:0};
const channelModel = {endpoint:'http://inference:8000/v1/chat/completions',model:'fixture-model'};
const timestamp = n => `1800000000.${String(n).padStart(6,'0')}`;

test('the CLI starts through a projected ConfigMap symlink', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'slack-bridge-entry-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const actual = fileURLToPath(new URL('./slack_dm_bridge/bridge.mjs',import.meta.url));
  const mounted = path.join(dir,'bridge.mjs');
  await fs.symlink(actual,mounted);
  const run = spawnSync(process.execPath,[mounted,path.join(dir,'missing.json')],{encoding:'utf8'});
  assert.equal(run.status,1);
  assert.match(run.stderr,/Slack bridge stopped/);
});
function envelope(n = 1, overrides = {}, payloadOverrides = {}) {
  return {type:'events_api',envelope_id:'envelope-' + n,payload:{type:'event_callback',team_id:config.teamId,
    api_app_id:config.appId,event_id:'Ev' + n,event:{type:'message',channel_type:'im',channel:'D12345678',
      user:'U12345678',text:'Collect logs and consult the Research Agent.',ts:timestamp(n),...overrides},...payloadOverrides}};
}
function mention(n, overrides = {}, payloadOverrides = {}) {
  return envelope(n,{type:'app_mention',channel_type:undefined,channel:'C12345678',
    text:'<@U01234567> Inspect the test job.',...overrides},payloadOverrides);
}
function channelReply(n, overrides = {}) {
  return envelope(n,{channel_type:'channel',channel:'C12345678',thread_ts:timestamp(1),
    text:'Follow up on the original request.',...overrides});
}
async function setup(t, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'slack-bridge-test-'));
  const clock = {value:1800000000000};
  const sent = [], runs = [], channelRuns = [], logs = [], history = new Map();
  const clients = {
    secret:async name => name === 'publishToken' ? 'fixture-publish-key-with-at-least-32-characters' : 'fixture',
    channelChat:async messages => {
      channelRuns.push(messages);
      return 'Model reply for the channel thread.';
    },
    slack:async (method,body) => {
      if (method === 'auth.test') return {ok:true,team_id:config.teamId,user_id:config.botUserId,bot_id:'B01234567'};
      if (method === 'conversations.open') return {channel:{id:body.users === 'U12345678' ? 'D12345678' : 'D23456789',is_im:true,user:body.users}};
      if (method === 'conversations.info') return {channel:{id:body.channel,context_team_id:config.teamId,
        is_channel:true,is_member:true}};
      if (method === 'chat.postMessage') {
        sent.push(body); return {ok:true,channel:body.channel,ts:timestamp(100 + sent.length)};
      }
      throw new Error('unexpected_method');
    },
    mosaic:async (url,body) => {
      if (url === '/api/openclaw/commands') return {commands:[]};
      if (url === '/api/headless/chat') {
        runs.push(body); history.set(body.sessionKey,{hasActiveRun:false,messages:[
          {role:'user',content:body.prompt},{role:'assistant',content:'Observed logs; Research guidance; evidence gaps.',stopReason:'stop'}]});
        return {success:true,runId:'run-' + runs.length};
      }
      return history.get(new URL(url,'http://fixture').searchParams.get('sessionKey')) ?? {hasActiveRun:true};
    },
  };
  let bridge = new Bridge({...config,stateDir:dir,...overrides},{clients,now:() => clock.value,log:r => logs.push(r)});
  t.after(async () => { bridge.close(); await fs.rm(dir,{recursive:true,force:true}); });
  return {get bridge() { return bridge; },clients,sent,runs,channelRuns,logs,clock,dir,
    restart(delta = {}) { bridge.close(); bridge = new Bridge({...config,stateDir:dir,...overrides,...delta},
      {clients,now:() => clock.value,log:r => logs.push(r)}); return bridge; },
    async drain(n = 20) { for (let i = 0; i < n && bridge.store.jobs().length; i++) { clock.value += 2000; await bridge.tick(); } },
  };
}

test('configuration fixes workspace/app identity and requires one private credential source', () => {
  assert.doesNotThrow(() => validateConfig(config));
  for (const delta of [{teamId:'*'},{appId:'wrong'},{allowedUserIds:[]},{allowedUserIds:['*']},
    {allowedUserIds:[config.botUserId]},{allowedUserIds:['U12345678','U12345678']},
    {credentialSocket:'/run/broker.sock'},{credentialsFile:undefined},{stateDir:'relative'},
    {mosaicUrl:'http://user:secret@host/'},{mosaicUrl:'https://host/path'},{concurrency:0},
    {allowedChannels:{'*':['U12345678']}},{allowedChannels:{D12345678:['U12345678']}},
    {allowedChannels:{C12345678:['U12345678','U12345678']}},{channelThreadRepliesEnabled:'true'},
    {channelModel:{...channelModel,endpoint:'file:///v1/chat/completions'}},
    {channelModel:{...channelModel,endpoint:'http://secret@localhost/chat/completions'}}]) {
    assert.throws(() => validateConfig({...config,...delta}));
  }
  assert.doesNotThrow(() => validateConfig({...config,credentialsFile:undefined,credentialSocket:'/run/broker.sock'}));
});

test('startup verifies Bot Token identity against the configured workspace and bot', async t => {
  const x = await setup(t); await x.bridge.verify();
  x.clients.slack = async () => ({team_id:'T99999999',user_id:config.botUserId,bot_id:'B01234567'});
  await assert.rejects(x.bridge.verify(),/identity_mismatch/);
});

test('workspace/app/sender/DM filters reject unauthorized, bot, edit and shared-channel events', async t => {
  const x = await setup(t);
  assert.equal(x.bridge.accept(mention(1)),false);
  for (const event of [{user:'U99999999'},{user:config.botUserId},{bot_id:'B01234567'},{app_id:'A99999999'},
    {subtype:'message_changed'},{subtype:'message_deleted'},{channel_type:'group'},{channel:'C12345678'},
    {hidden:true},{text:' '},{ts:'bad'},{thread_ts:'bad'}]) assert.equal(x.bridge.accept(envelope(1,event)),false);
  for (const payload of [{team_id:'T99999999'},{api_app_id:'A99999999'},{is_ext_shared_channel:true}])
    assert.equal(x.bridge.accept(envelope(1,{},payload)),false);
  assert.deepEqual(x.bridge.store.counts(),{});
});

test('channel mentions acknowledge the original thread and keep the answer and follow-ups private', async t => {
  const x = await setup(t,{allowedChannels:{C12345678:['U12345678']},allowedUserIds:['U23456789']});
  const question = 'Channel fixture question';
  const event = mention(2,{text:'<@U01234567> ' + question,thread_ts:timestamp(1)});
  assert.equal(x.bridge.accept(event),true);
  assert.equal(x.bridge.accept(event),false);
  assert.equal(x.bridge.accept(mention(3,{ts:timestamp(2)})),false);
  assert.equal(x.bridge.accept(mention(4,{type:'message',channel_type:'channel',ts:timestamp(2)})),false);
  assert.equal(x.bridge.accept(envelope(8)),false);
  assert.throws(() => x.bridge.publish({incidentId:'other',userId:'U12345678',report:'report'}),/invalid_incident/);
  x.restart();
  await x.drain();
  assert.equal(x.sent.length,3);
  assert.deepEqual(x.sent.map(m=>[m.channel,m.thread_ts]),[
    ['C12345678',timestamp(1)],['D12345678',undefined],['D12345678',timestamp(102)],
  ]);
  assert.match(x.sent[0].text,/MOSAIC operations assistant/);
  assert.doesNotMatch(x.sent[0].text,/Channel fixture question|Research guidance/);
  assert.match(x.sent[2].text,/Research guidance/);
  assert.equal(x.runs.length,1);
  assert.equal(x.runs[0].accessMode,'view');
  assert.ok(isReadonlyAutomationSession(x.runs[0].sessionKey));
  assert.match(x.runs[0].prompt,/Channel fixture question/);
  assert.doesNotMatch(x.runs[0].prompt,/<@U01234567>/);
  x.restart();
  assert.equal(x.bridge.accept(envelope(5,{thread_ts:timestamp(102)})),true);
  await x.drain();
  assert.equal(x.runs[1].sessionKey,x.runs[0].sessionKey);
  assert.equal(x.sent.at(-1).thread_ts,timestamp(102));
});

test('optional unmentioned replies reuse an existing channel request across restart', async t => {
  const x = await setup(t,{allowedChannels:{C12345678:['U12345678','U23456789']}});
  assert.equal(x.bridge.accept(mention(1)),true);
  await x.drain();
  const privateRoot = x.sent[2].thread_ts;
  assert.equal(x.bridge.accept(channelReply(2)),false);
  x.restart({channelThreadRepliesEnabled:true});
  for (const delta of [{user:'U23456789'},{channel:'C99999999'},
    {thread_ts:timestamp(10)},{thread_ts:undefined},{text:'<@U01234567> Also check this.'}]) {
    assert.equal(x.bridge.accept(channelReply(2,delta)),false);
  }
  const follow = channelReply(2);
  assert.equal(x.bridge.accept(follow),true);
  assert.equal(x.bridge.accept(follow),false);
  assert.equal(x.bridge.accept(channelReply(3,{ts:timestamp(2)})),false);
  await x.drain();
  assert.equal(x.runs.length,2);
  assert.equal(x.runs[1].sessionKey,x.runs[0].sessionKey);
  assert.match(x.runs[1].prompt,/Follow up on the original request/);
  assert.equal(x.sent.length,4);
  assert.equal(x.sent.at(-1).channel,'D12345678');
  assert.equal(x.sent.at(-1).thread_ts,privateRoot);
});

test('thread replies received before the initial DM is sent wait for its verified conversation', async t => {
  const x = await setup(t,{channelThreadRepliesEnabled:true,allowedChannels:{C12345678:['U12345678']}});
  assert.equal(x.bridge.accept(channelReply(2)),false);
  assert.equal(x.bridge.accept(mention(1)),true);
  assert.equal(x.bridge.accept(channelReply(2)),true);
  await x.drain();
  assert.equal(x.runs.length,2);
  assert.equal(x.runs[1].sessionKey,x.runs[0].sessionKey);
  assert.equal(x.sent.at(-1).thread_ts,x.sent[2].thread_ts);
});

test('opt-in channel replies use their original group thread and isolated conversation history', async t => {
  const x = await setup(t,{channelModel,channelThreadRepliesEnabled:true,
    allowedChannels:{C12345678:['U12345678','U23456789']}});
  assert.equal(x.bridge.accept(mention(1,{text:'<@U01234567> Who are you?'})),true);
  await x.drain();
  x.restart();
  assert.equal(x.bridge.accept(channelReply(2,{user:'U23456789'})),false);
  assert.equal(x.bridge.accept(channelReply(2)),true);
  assert.equal(x.bridge.accept(channelReply(3,{ts:timestamp(2)})),false);
  await x.drain();
  assert.equal(x.runs.length,0);
  assert.equal(x.channelRuns.length,2);
  assert.deepEqual(x.channelRuns[1].slice(1),[
    {role:'user',content:'Who are you?'},
    {role:'assistant',content:'Model reply for the channel thread.'},
    {role:'user',content:'Follow up on the original request.'},
  ]);
  assert.deepEqual(x.sent.map(m=>[m.channel,m.thread_ts]),[
    ['C12345678',timestamp(1)],['C12345678',timestamp(1)],
  ]);
});

test('switching existing channels to group replies uses public inputs from legacy threads and excludes DM answers', async t => {
  const x = await setup(t,{channelThreadRepliesEnabled:true,allowedChannels:{C12345678:['U12345678']}});
  assert.equal(x.bridge.accept(mention(1,{text:'<@U01234567> Public initial question'})),true);
  await x.drain();
  assert.match(x.sent.at(-1).text,/Research guidance/);
  const root = x.sent.at(-1).thread_ts;
  x.restart({channelModel});
  assert.equal(x.bridge.accept(channelReply(2)),true);
  assert.equal(x.bridge.accept(envelope(3,{thread_ts:root,text:'Separate private question'})),true);
  await x.drain();
  assert.equal(x.channelRuns.length,1);
  const messages = JSON.stringify(x.channelRuns[0]);
  assert.match(messages,/Public initial question/);
  assert.doesNotMatch(messages,/Research guidance|Separate private question/);
  assert.deepEqual(x.sent.slice(-2).map(m=>[m.channel,m.thread_ts]),[
    ['C12345678',timestamp(1)],['D12345678',root],
  ]);
});

test('channel and user allowlists, membership, workspace and DM identity gate channel requests', async t => {
  const x = await setup(t,{allowedChannels:{C12345678:['U12345678']}});
  for (const change of [{channel:'C99999999'},{user:'U99999999'},{user:'U23456789'},{subtype:'bot_message'},
    {text:'<@U99999999> Other app'},{text:'<@U01234567>'}]) {
    assert.equal(x.bridge.accept(mention(1,change)),false);
  }
  assert.equal(x.bridge.accept(mention(1,{}, {is_ext_shared_channel:true})),false);
  const call = x.clients.slack;
  let flags = {};
  x.clients.slack = async (method, body) => {
    const response = await call(method,body);
    return method === 'conversations.info' ? {channel:{...response.channel,...flags}} : response;
  };
  for (const [i,change] of [
    {is_member:false}, {is_ext_shared:true}, {is_org_shared:true}, {is_shared:true},
    {context_team_id:'T99999999'}, {is_mpim:true}, {is_archived:true}, {is_pending_ext_shared:true},
  ].entries()) {
    flags = change;
    assert.equal(x.bridge.accept(mention(i+2)),true);
    await x.drain();
  }
  flags = {};
  assert.equal(x.bridge.accept(mention(10)),true);
  x.restart({allowedChannels:{}});
  await x.drain();
  assert.equal(x.runs.length,0);
  assert.equal(x.sent.length,0);
  assert.deepEqual(x.bridge.store.counts(),{rejected:18});
  assert.equal(x.bridge.accept(envelope(11)),true);
  await x.drain();
  assert.equal(x.runs.length,1);
});

test('channel acknowledgment and private request are admitted in one durable transaction', async t => {
  const x = await setup(t,{capacity:1,allowedChannels:{C12345678:['U12345678']}});
  assert.throws(() => x.bridge.accept(mention(1)),/state_capacity/);
  assert.deepEqual(x.bridge.store.counts(),{});
});

test('durable inbox deduplicates event IDs and duplicate message timestamps across restarts', async t => {
  const x = await setup(t); assert.equal(x.bridge.accept(envelope()),true);
  assert.equal(x.bridge.accept(envelope()),false);
  assert.equal(x.bridge.accept(envelope(2,{ts:timestamp(1)})),false);
  x.restart(); assert.equal(x.bridge.accept(envelope()),false);
  await x.drain(); assert.equal(x.runs.length,1); assert.equal(x.sent.length,1);
  assert.deepEqual(x.bridge.store.counts(),{done:1});
  assert.equal(x.bridge.accept(envelope(3,{ts:timestamp(1)})),false);
});

test('state refuses a different installation or a second writer and permits reopen after close', async t => {
  const x = await setup(t);
  assert.throws(() => new Store(x.dir,{}),/locked/);
  const directory = path.join(x.dir,'other');
  const first = new Store(directory,{team:'one'}); first.close();
  assert.throws(() => new Store(directory,{team:'two'}),/binding_mismatch/);
  const again = new Store(directory,{team:'one'}); again.close();
});

test('capacity failure rolls back thread binding and does not acknowledge new work', async t => {
  const x = await setup(t,{capacity:1}); x.bridge.accept(envelope());
  assert.throws(() => x.bridge.accept(envelope(2)),/state_capacity/);
  assert.equal(x.bridge.store.thread(x.bridge.threadId('D12345678',timestamp(2))),undefined);
});

test('root DM and threaded follow-up use the same server-derived permanently View session', async t => {
  const x = await setup(t); x.bridge.accept(envelope()); await x.drain();
  x.bridge.accept(envelope(2,{thread_ts:timestamp(1)})); await x.drain();
  assert.equal(x.runs.length,2); assert.equal(x.runs[0].sessionKey,x.runs[1].sessionKey);
  for (const run of x.runs) {
    assert.equal(run.accessMode,'view'); assert.ok(isReadonlyAutomationSession(run.sessionKey));
    assert.equal(sessionAllowsEdit(run.sessionKey,{mode:'auto'}),false);
  }
  assert.ok(x.sent.every(m => m.thread_ts === timestamp(1)));
});

test('unknown or another users thread is never mapped to the most recent incident', async t => {
  const x = await setup(t);
  assert.equal(x.bridge.accept(envelope(2,{thread_ts:timestamp(1)})),false);
  x.bridge.accept(envelope());
  assert.equal(x.bridge.accept(envelope(3,{thread_ts:timestamp(1),user:'U23456789'})),false);
});

test('DM identity is checked before any model call and removed users are rejected after restart', async t => {
  const x = await setup(t); x.bridge.accept(envelope(1,{channel:'D99999999'}));
  await x.drain(); assert.equal(x.runs.length,0); assert.deepEqual(x.bridge.store.counts(),{rejected:1});
  x.bridge.accept(envelope(2)); x.restart({allowedUserIds:['U23456789']});
  await x.drain(); assert.equal(x.runs.length,0);
});

test('verifies Grid DMs against the authenticated enterprise and rejects external or unverified sharing', async t => {
  const enterpriseId = 'E12345678';
  const sharedDm = {is_shared:true,is_org_shared:true,context_team_id:enterpriseId};
  const x = await setup(t);
  const slack = x.clients.slack;
  let sharing = sharedDm;
  let authEnterpriseId = enterpriseId;
  x.clients.slack = async (method,body) => {
    const response = await slack(method,body);
    if (method === 'auth.test') return {...response,enterprise_id:authEnterpriseId};
    if (method === 'conversations.open') return {channel:{...response.channel,...sharing}};
    return response;
  };
  await x.bridge.verify();
  const publish = n => x.bridge.publish({incidentId:'grid-' + n,userId:'U12345678',report:'Grid report'});
  const job = publish(1);
  await x.drain();
  const incident = x.bridge.store.get(job.id);
  assert.equal(incident.state,'done');
  assert.equal(x.bridge.accept(envelope(2,{thread_ts:incident.root})),true);
  await x.drain();
  assert.equal(x.runs.length,1);
  assert.equal(x.sent.at(-1).thread_ts,incident.root);

  for (const [index, flags] of [
    {is_ext_shared:true}, {is_pending_ext_shared:true}, {connected_team_ids:['T23456789']},
    {context_team_id:'E23456789'}, {context_team_id:undefined}, {is_org_shared:undefined},
    {user:'U23456789'}, {is_im:false},
  ].entries()) {
    sharing = {...sharedDm,...flags};
    const rejected = publish(index + 3);
    await x.drain();
    assert.equal(x.bridge.store.get(rejected.id).state,'rejected');
  }
  sharing = sharedDm;
  authEnterpriseId = undefined;
  await x.bridge.verify();
  const unverified = publish(11);
  await x.drain();
  assert.equal(x.bridge.store.get(unverified.id).state,'rejected');
  assert.equal(x.runs.length,1);
  assert.equal(x.sent.length,3);
});

test('incident publication is idempotent and conflicting or unauthorized reports fail closed', async t => {
  const x = await setup(t), report = {incidentId:'xid-1',userId:'U12345678',report:'All complete evidence.'};
  const first = x.bridge.publish(report); assert.equal(first.duplicate,false);
  assert.equal(x.bridge.publish(report).id,first.id); assert.equal(x.bridge.publish(report).duplicate,true);
  assert.throws(() => x.bridge.publish({...report,report:'different'}),/conflict/);
  assert.throws(() => x.bridge.publish({...report,userId:'U99999999'}),/invalid/);
  assert.throws(() => x.bridge.publish({...report,report:'x'.repeat(196609)}),/invalid/);
});

test('complete Unicode report is published losslessly; mentions and unfurls remain inert', async t => {
  const x = await setup(t), report = 'Xid 95 <@U99999999> <!channel> **evidence**\n中😀 '.repeat(180);
  const job = x.bridge.publish({incidentId:'xid-1',userId:'U12345678',report}); await x.drain();
  const row = x.bridge.store.get(job.id);
  assert.equal(row.state,'done'); assert.ok(row.root);
  assert.equal(x.sent.slice(1).map(m => m.blocks[0].text.text).join(''),report);
  assert.ok(x.sent.slice(1).every(m => m.thread_ts === row.root && m.mrkdwn === false &&
    m.blocks[0].text.type === 'plain_text' && m.unfurl_links === false && m.reply_broadcast === false));
  assert.ok(x.sent.every(m => !/<[@!]/.test(m.text)));
  assert.equal(chunks(report).join(''),report); assert.ok(chunks(report).every(p => [...p].length <= 2800));
});

test('two incident threads and another user keep their full report contexts separate after restart', async t => {
  const x = await setup(t);
  const one = x.bridge.publish({incidentId:'xid-1',userId:'U12345678',report:'EVIDENCE_ONE GPU Xid 95'});
  const two = x.bridge.publish({incidentId:'network-2',userId:'U12345678',report:'EVIDENCE_TWO network CRC'});
  const three = x.bridge.publish({incidentId:'xid-1',userId:'U23456789',report:'OTHER_USER private observation'});
  await x.drain(); x.restart();
  const roots = [one,two,three].map(j => x.bridge.store.get(j.id));
  x.bridge.accept(envelope(10,{thread_ts:roots[0].root}));
  x.bridge.accept(envelope(11,{thread_ts:roots[1].root}));
  x.bridge.accept(envelope(12,{thread_ts:roots[2].root,user:'U23456789',channel:'D23456789'}));
  await x.drain(); assert.equal(x.runs.length,3);
  assert.equal(new Set(x.runs.map(r => r.sessionKey)).size,3);
  assert.match(x.runs[0].prompt,/EVIDENCE_ONE/); assert.doesNotMatch(x.runs[0].prompt,/EVIDENCE_TWO|OTHER_USER/);
  const forTwo = x.runs.find(r => r.prompt.includes('EVIDENCE_TWO'));
  assert.doesNotMatch(forTwo.prompt,/EVIDENCE_ONE|OTHER_USER/);
  const forOther = x.runs.find(r => r.prompt.includes('OTHER_USER'));
  assert.doesNotMatch(forOther.prompt,/EVIDENCE_ONE|EVIDENCE_TWO/);
});

test('headless timeout and restart recover by history without submitting the turn twice', async t => {
  const x = await setup(t), original = x.clients.mosaic; let submissions = 0, allowHistory = false;
  x.clients.mosaic = async (url,body) => {
    if (url === '/api/headless/chat') { submissions++; await original(url,body); throw new Error('timeout'); }
    if (url.startsWith('/api/openclaw/chat') && !allowHistory) return {hasActiveRun:true};
    return original(url,body);
  };
  x.bridge.accept(envelope()); await x.bridge.tick(); assert.equal(submissions,1);
  x.restart(); allowHistory = true; x.clock.value += 12000; await x.drain();
  assert.equal(submissions,1); assert.equal(x.sent.length,1); assert.deepEqual(x.bridge.store.counts(),{done:1});
});

test('incomplete tool-call and stale answers are not delivered as completed investigations', () => {
  const h = {hasActiveRun:false,messages:[{role:'user',content:'unique prompt'},
    {role:'assistant',content:'Done',stopReason:'stop'}]};
  assert.equal(completedAnswer(h,'unique prompt'),'Done');
  assert.equal(completedAnswer(h,'different prompt'),null);
  assert.equal(completedAnswer({...h,hasActiveRun:true},'unique prompt'),null);
  assert.equal(completedAnswer({...h,messages:[h.messages[0],{role:'assistant',content:[{type:'toolCall'}]}]},'unique prompt'),null);
  assert.throws(() => completedAnswer({...h,messages:[h.messages[0],{...h.messages[1],stopReason:'length'}]},'unique prompt'));
});

test('unavailable history eventually produces a failure notice without another Agent submission', async t => {
  const x = await setup(t); let submissions = 0;
  x.clients.mosaic = async (url) => { if (url === '/api/headless/chat') submissions++; throw new Error('offline'); };
  x.bridge.accept(envelope()); await x.bridge.tick();
  assert.equal(submissions,1); assert.equal(x.sent.length,0);
  x.clock.value += 901000; await x.drain();
  assert.equal(submissions,1); assert.match(x.sent[0].text,/not confirmed completion/);
  assert.deepEqual(x.bridge.store.counts(),{done:1});
});

test('a waiting recipient does not block another recipient, or allow later turns to overwrite history', async t => {
  const x = await setup(t), original = x.clients.mosaic;
  x.clients.mosaic = async (url,body) => {
    if (body?.prompt.includes('FIRST_USER_PENDING')) return {success:true};
    return original(url,body);
  };
  x.bridge.accept(envelope(1,{text:'FIRST_USER_PENDING'}));
  x.bridge.accept(envelope(2,{thread_ts:timestamp(1),text:'must wait'}));
  x.bridge.accept(envelope(3,{user:'U23456789',channel:'D23456789'}));
  await x.drain(3);
  assert.equal(x.runs.length,1); assert.equal(x.sent.length,1); assert.equal(x.sent[0].channel,'D23456789');
  assert.equal(x.bridge.store.counts().running,1); assert.equal(x.bridge.store.counts().queued,1);
});

test('DM manifest requests no user tokens or channel/group scopes', async () => {
  const manifest = JSON.parse(await fs.readFile(new URL('./slack_dm_bridge/slack-app-manifest.json',import.meta.url)));
  assert.deepEqual(manifest.oauth_config.scopes,{bot:['chat:write','im:write','im:history']});
  assert.deepEqual(manifest.settings.event_subscriptions.bot_events,['message.im']);
  assert.equal(manifest.features.app_home.messages_tab_read_only_enabled,false);
  assert.equal(manifest.settings.socket_mode_enabled,true);
});

test('uncertain outgoing delivery remains stopped across restart instead of duplicating', async t => {
  const x = await setup(t), original = x.clients.slack; let sends = 0;
  x.clients.slack = async (method,body) => {
    if (method === 'chat.postMessage') { sends++; throw new Error('network_timeout'); }
    return original(method,body);
  };
  const job = x.bridge.publish({incidentId:'xid-1',userId:'U12345678',report:'report'});
  await x.drain(); assert.equal(x.bridge.store.get(job.id).state,'send_unknown');
  x.restart(); await x.drain(); assert.equal(sends,1);
});

test('crash after durable send intent is not replayed', async t => {
  const x = await setup(t); x.bridge.accept(envelope());
  const row = x.bridge.store.jobs()[0]; row.state = 'sending'; x.bridge.store.save(row);
  x.restart(); await x.drain(); assert.equal(x.sent.length,0);
  assert.equal(x.bridge.store.get(row.id).state,'send_unknown');
});

test('429 uses Retry-After and continues from the last confirmed report chunk', async t => {
  const x = await setup(t), original = x.clients.slack; let limit = true;
  x.clients.slack = async (method,body) => {
    if (method === 'chat.postMessage' && body.thread_ts && limit) {
      limit = false; throw new TransportError('rate_limited',{definite:true,retryAfter:60000});
    }
    return original(method,body);
  };
  const j = x.bridge.publish({incidentId:'xid-1',userId:'U12345678',report:'a'.repeat(3000)});
  await x.bridge.tick(); x.clock.value += 2000; await x.bridge.tick();
  assert.equal(x.sent.length,1); assert.equal(x.bridge.store.get(j.id).state,'ready');
  x.restart(); await x.drain(2); assert.equal(x.sent.length,1);
  x.clock.value += 60000; await x.drain(); assert.equal(x.sent.length,3);
  assert.equal(x.sent.slice(1).map(m => m.text).join(''),'a'.repeat(3000));
});

test('audit events exclude messages, reports, tokens, model output and raw errors', async t => {
  const x = await setup(t); x.bridge.publish({incidentId:'xid-1',userId:'U12345678',report:'PRIVATE_REPORT'});
  await x.drain(); x.bridge.accept(envelope(3,{text:'PRIVATE_QUESTION'})); await x.drain();
  const logs = JSON.stringify(x.logs);
  assert.doesNotMatch(logs,/PRIVATE_REPORT|PRIVATE_QUESTION|Research guidance|fixture-publish-key/);
  assert.ok(x.logs.every(row => Object.keys(row).every(k => ['at','event','id'].includes(k))));
});

test('HTTP publication requires authentication, returns durable status and preserves idempotency', async t => {
  const x = await setup(t); await x.bridge.serve();
  const url = `http://127.0.0.1:${x.bridge.server.address().port}`;
  const payload = {incidentId:'xid-1',userId:'U12345678',report:'complete report'};
  assert.equal((await fetch(url + '/incidents',{method:'POST'})).status,401);
  const headers = {authorization:'Bearer ' + await x.clients.secret('publishToken'),'content-type':'application/json'};
  const response = await fetch(url + '/incidents',{method:'POST',headers,body:JSON.stringify(payload)});
  assert.equal(response.status,202); const job = await response.json();
  const conflict = await fetch(url + '/incidents',{method:'POST',headers,body:JSON.stringify({...payload,report:'changed'})});
  assert.equal(conflict.status,409);
  await x.drain();
  const status = await (await fetch(url + '/incidents/' + job.id,{headers})).json();
  assert.equal(status.state,'done'); assert.equal(status.confirmedParts,1); assert.ok(status.threadTs);
  assert.equal(status.report,undefined); assert.equal(status.reportSha256.length,64);
  assert.equal((await fetch(url + '/healthz')).status,503);
  x.bridge.connected = true; assert.equal((await fetch(url + '/healthz')).status,200);
});

test('credential file is reread per request; user tokens and world-readable files are rejected', async t => {
  const x = await setup(t); const file = path.join(x.dir,'credentials.json');
  await fs.writeFile(file,JSON.stringify({botToken:['xoxb','fixture-one'].join('-')}),{mode:0o600});
  assert.equal(await credential({credentialsFile:file},'botToken'),['xoxb','fixture-one'].join('-'));
  await fs.writeFile(file,JSON.stringify({botToken:['xoxb','fixture-two'].join('-')}));
  assert.equal(await credential({credentialsFile:file},'botToken'),['xoxb','fixture-two'].join('-'));
  await fs.writeFile(file,JSON.stringify({botToken:['xoxp','fixture-user'].join('-')}));
  await assert.rejects(credential({credentialsFile:file},'botToken'),/bot_token_required/);
  await fs.chmod(file,0o644); await assert.rejects(credential({credentialsFile:file},'botToken'),/unsafe/);
});

test('local broker returns only the requested secret without putting it in the agent request', async t => {
  const x = await setup(t); const socket = path.join(x.dir,'broker.sock'); const paths = [];
  const server = http.createServer((req,res) => { paths.push(req.url); res.end(JSON.stringify({value:['xoxb','fixture-broker'].join('-')})); });
  await new Promise(resolve => server.listen(socket,resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  assert.equal(await credential({credentialSocket:socket},'botToken'),['xoxb','fixture-broker'].join('-'));
  assert.deepEqual(paths,['/v1/credentials/botToken']);
});

test('transport disables redirects, separates credentials, bounds errors and honors 429', async () => {
  const calls = [], secrets = [];
  const client = new Clients(config,{readCredential:async (_c,name) => { secrets.push(name); return 'fixture-' + name; },
    fetchFn:async (url,options) => { calls.push({url:String(url),options}); return new Response(JSON.stringify({ok:true}),{status:200}); }});
  await client.slack('apps.connections.open'); await client.slack('auth.test');
  await client.mosaic('/api/headless/chat',{prompt:'question'});
  await client.slack('conversations.info',{channel:'C12345678'});
  assert.deepEqual(secrets,['appToken','botToken','mosaicToken','botToken']);
  assert.ok(calls.every(c => c.options.redirect === 'error'));
  assert.equal(calls[2].options.headers.authorization,'Bearer fixture-mosaicToken');
  assert.doesNotMatch(calls[2].options.body,/botToken|appToken/);
  assert.equal(calls[3].url,'https://slack.com/api/conversations.info?channel=C12345678');
  assert.equal(calls[3].options.method,'GET');
  assert.equal(calls[3].options.body,undefined);
  client.fetch = async () => new Response('',{status:429,headers:{'retry-after':'45'}});
  await assert.rejects(client.slack('chat.postMessage'),e => e.definite && e.retryAfter === 45000);
  client.fetch = async () => { throw new Error('SENSITIVE_TOKEN_AND_BODY'); };
  await assert.rejects(client.slack('chat.postMessage'),e => e.message === 'slack_transport_unknown' && !e.definite);
});

test('channel model requests carry only the channel chat and never advertise tools or send tokens', async () => {
  const client = new Clients({...config,channelModel}, {
    readCredential:async () => assert.fail('channel inference must not read credentials'),
    fetchFn:async (url,opts) => {
      assert.equal(url,channelModel.endpoint);
      assert.equal(opts.redirect,'error');
      assert.equal(opts.headers.authorization,undefined);
      assert.deepEqual(Object.keys(JSON.parse(opts.body)).sort(),['max_tokens','messages','model','stream']);
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'Channel response'}}]}));
    },
  });
  assert.equal(await client.channelChat([{role:'user',content:'Who are you?'}]),'Channel response');
});

test('Socket Mode ACK follows durable persistence; disk failure leaves the envelope unacknowledged', async t => {
  const x = await setup(t); let ack = false;
  class Socket extends EventTarget {
    constructor() {
      super(); queueMicrotask(() => {
        this.dispatchEvent(new Event('open'));
        this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'hello'})}));
        this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(envelope())}));
        x.bridge.stopping = true; this.close();
      });
    }
    send(data) { assert.equal(x.bridge.store.counts().queued,1); assert.equal(JSON.parse(data).envelope_id,'envelope-1'); ack = true; }
    close() { this.dispatchEvent(new Event('close')); }
  }
  x.clients.slack = async () => ({url:'wss://wss-primary.slack.com/fixture'});
  await socketLoop(x.bridge,{WebSocketClass:Socket}); assert.equal(ack,true);
  x.bridge.stopping = false; ack = false;
  x.bridge.accept = () => { throw new Error('disk_full'); };
  await socketLoop(x.bridge,{WebSocketClass:Socket}); assert.equal(ack,false);
  for (const bad of ['ws://wss-primary.slack.com/','wss://evil.test/','wss://user:secret@wss-primary.slack.com/'])
    assert.throws(() => socketUrl(bad));
});

test('end-to-end HTTP Slack/MOSAIC fixtures: report, restart, thread follow-up, tool-evidence answer', async t => {
  const x = await setup(t); let currentPrompt = '', session = ''; const outbound = [], requests = [];
  const server = http.createServer(async (req,res) => {
    const buffers = []; for await (const b of req) buffers.push(b);
    const body = buffers.length ? JSON.parse(Buffer.concat(buffers).toString()) : undefined;
    requests.push({url:req.url,authorization:req.headers.authorization});
    let result;
    if (req.url === '/slack/conversations.open') result = {ok:true,channel:{id:'D12345678',is_im:true,user:'U12345678'}};
    else if (req.url === '/slack/chat.postMessage') { outbound.push(body); result = {ok:true,channel:body.channel,ts:timestamp(500 + outbound.length)}; }
    else if (req.url === '/api/headless/chat') {
      currentPrompt = body.prompt; session = body.sessionKey;
      assert.equal(body.accessMode,'view'); assert.match(currentPrompt,/FULL_XID_EVIDENCE/);
      result = {success:true,runId:'run-fixture'};
    } else result = {hasActiveRun:false,messages:[{role:'user',content:currentPrompt},
      {role:'assistant',content:[{type:'toolCall',name:'run_kubectl'}],stopReason:'toolUse'},
      {role:'toolResult',content:'GPU pod logs'},
      {role:'assistant',content:'现场证据：GPU pod logs。Research Agent：文档建议。缺口：未检查 BMC。',stopReason:'stop'}]};
    res.setHeader('content-type','application/json'); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const real = new Clients(config,{readCredential:async (_c,name) => 'fixture-' + name,
    fetchFn:(url,options) => {
      const source = new URL(url); const route = source.hostname === 'slack.com' ?
        '/slack/' + source.pathname.split('/').at(-1) : source.pathname + source.search;
      return fetch(origin + route,options);
    }});
  x.bridge.clients = real;
  const job = x.bridge.publish({incidentId:'gpu-fixture',userId:'U12345678',report:'FULL_XID_EVIDENCE'});
  await x.drain(); const root = x.bridge.store.get(job.id).root;
  x.restart(); x.bridge.clients = real;
  x.bridge.accept(envelope(42,{thread_ts:root})); await x.drain();
  assert.ok(session.startsWith('agent:default:mosaic-automation-alert-slack-'));
  assert.match(outbound.at(-1).text,/现场证据.*Research Agent/); assert.equal(outbound.at(-1).thread_ts,root);
  assert.ok(requests.filter(r => r.url.startsWith('/api/')).every(r => r.authorization === 'Bearer fixture-mosaicToken'));
  assert.deepEqual(x.bridge.store.counts(),{done:2});
});
