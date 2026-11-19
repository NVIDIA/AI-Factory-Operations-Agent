// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const password = 'synthetic-only-quote"slash\\line\n=value';
const token = 'synthetic-only-protected-access-token';
const senderId = '22222222-2222-2222-2222-222222222222';
const recipientId = '33333333-3333-3333-3333-333333333333';
const credentials = { username: 'service@example.invalid', password,
  clientId: '11111111-1111-1111-1111-111111111111', tenantId: 'organizations', clientSecret: '' };
const source = readFileSync(new URL('./teams_graph_probe/probe.cjs', import.meta.url), 'utf8')
  .replace('main().catch(error => {', 'const completion = main().catch(error => {');

async function run(scenario = 'send', config = {}) {
  const requests = [], output = [];
  const env = { MOSAIC_TEST_RUN_ID: 'test-fixture', MOSAIC_TEAMS_RECIPIENT_ID: recipientId };
  if (scenario !== 'default') env.MOSAIC_TEST_PROBE_MODE = ['identity','bind'].includes(scenario) ? scenario : 'send';
  Object.assign(env, config);
  const processMock = { env, stdout: { write: value => output.push(value) }, exitCode: 0 };
  const context = vm.createContext({ URL, URLSearchParams, AbortSignal, Date, JSON, encodeURIComponent,
    process: processMock,
    require: name => name === 'node:fs/promises' ? {
      readFile: async () => scenario === 'invalid-json' ? '{secret:' + password : JSON.stringify(credentials),
      stat: async () => ({ mode: 0o440, uid: 0, gid: 1000, size: 256, mtime: new Date(0) }),
    } : name === 'node:crypto' ? { randomUUID: () => 'fixture-request-id' } : (() => { throw new Error(name); })(),
    fetch: async (url, options) => {
      requests.push({ url, method: options.method, body: options.body });
      if (url.includes('/oauth2/v2.0/token')) {
        assert.equal(options.body.get('password'), password);
        assert.equal(options.body.get('grant_type'), 'password');
        if (scenario === 'identity' || scenario === 'default')
          assert.equal(options.body.get('scope'), 'https://graph.microsoft.com/User.Read');
        else if (env.MOSAIC_TEST_PROBE_MODE === 'bind-group')
          assert.equal(options.body.get('scope'), 'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Chat.ReadWrite');
        else assert.equal(options.body.get('scope'), 'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Chat.Create https://graph.microsoft.com/ChatMessage.Send' + (scenario === 'bind' ? ' https://graph.microsoft.com/Chat.ReadWrite' : ''));
        if (scenario === 'mfa' || scenario === 'consent') return new Response(JSON.stringify({
          error: 'invalid_grant', error_codes: [scenario === 'mfa' ? 50076 : 65001],
          error_description: 'sensitive echo ' + password,
        }), { status: 400 });
        return new Response(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: 3600 }));
      }
      assert.equal(options.headers.Authorization, 'Bearer ' + token);
      if (url.includes('/me?')) return new Response(JSON.stringify({ id: senderId,
        userPrincipalName: scenario === 'wrong-sender' ? 'other@example.invalid' : credentials.username }));
      if (env.MOSAIC_TEST_PROBE_MODE === 'bind-group') {
        assert.equal(options.method, 'GET');
        if (url.endsWith('/members')) return new Response(JSON.stringify({value:[{userId:senderId}],
          '@odata.nextLink': scenario === 'group-foreign-nextlink' ? 'https://example.invalid/v1.0/members'
            : 'https://graph.microsoft.com/v1.0/chats/group-fixture/members?page=2'}));
        if (url.endsWith('members?page=2')) return new Response(JSON.stringify({value:
          scenario === 'group-nonmember' ? [] : [{userId:recipientId}]}));
        if (url.endsWith('/chats/group-fixture')) return new Response(JSON.stringify({id:'group-fixture',
          chatType:scenario === 'group-wrong-type' ? 'oneOnOne' : 'group'}));
        throw new Error('Unexpected group URL');
      }
      if (url.endsWith('/chats')) {
        const members = JSON.parse(options.body).members;
        assert.deepEqual(members.map(m => m['user@odata.bind']), [
          `https://graph.microsoft.com/v1.0/users/${senderId}`,
          `https://graph.microsoft.com/v1.0/users/${recipientId}`,
        ]);
        assert.ok(members.every(m => m['@odata.type'] === '#microsoft.graph.aadUserConversationMember'));
        if (scenario === 'graph-error') return new Response(JSON.stringify({ error: {
          code: 'Forbidden', message: JSON.stringify({ password, token }),
        }}), { status: 403 });
        return new Response(JSON.stringify({ id: 'fixture-chat', chatType: 'oneOnOne' }), { status: 201 });
      }
      if (url.endsWith('/messages')) {
        assert.match(JSON.parse(options.body).body.content, /Run ID: test-fixture/);
        return new Response(JSON.stringify(scenario === 'missing-message-id' ? {} : { id: 'fixture-message' }), { status: 201 });
      }
      throw new Error('Unexpected URL');
    },
  });
  await vm.runInContext(source + '\ncompletion;', context);
  const raw = output.join('');
  for (const value of [password, JSON.stringify(password).slice(1, -1), token])
    assert.equal(raw.includes(value), false);
  return { requests, event: JSON.parse(raw), exitCode: processMock.exitCode };
}

test('Teams probe defaults to User.Read-only identity verification', async () => {
  const result = await run('default');
  assert.equal(result.requests.length, 2);
  assert.equal(result.event.stage, 'identity_verified');
  assert.ok(result.requests.every(r => !r.url.includes('/chats')));
});

test('Teams send uses explicit GUID members, preserves password characters and never emits tokens', async () => {
  const result = await run();
  assert.equal(result.requests.length, 4);
  assert.equal(result.event.stage, 'sent');
  assert.equal(result.event.messageId, 'fixture-message');
});

test('Teams bind reuses the probe to establish a fixed chat without sending a message', async () => {
  const result = await run('bind');
  assert.equal(result.event.stage, 'bound');
  assert.equal(result.event.chatId, 'fixture-chat');
  assert.equal(result.requests.length, 3);
  assert.ok(result.requests.every(r => !r.url.endsWith('/messages')));
});

const groupEnv={MOSAIC_TEST_PROBE_MODE:'bind-group',MOSAIC_TEAMS_GROUP_CHAT_ID:'group-fixture',
  MOSAIC_TEAMS_ALLOWED_USER_IDS:recipientId};
test('Teams group binding only reads the exact group and all member pages', async () => {
  const result=await run('group',groupEnv);
  assert.equal(result.event.stage,'bound');assert.equal(result.event.chatType,'group');
  assert.deepEqual(result.event.allowedUserIds,[recipientId]);assert.equal(result.requests.length,5);
  assert.ok(result.requests.slice(1).every(r=>r.method==='GET' && !r.url.includes('/messages')));
});
for(const scenario of ['group-nonmember','group-wrong-type','group-foreign-nextlink'])
test(`Teams ${scenario} fails closed without changing or sending to the group`, async () => {
  const result=await run(scenario,groupEnv);assert.equal(result.event.stage,'failed');
  assert.ok(result.requests.every(r=>!r.url.includes('example.invalid') && !r.url.includes('/messages')));
});
test('Teams group binding rejects invalid explicit allowlists before login', async () => {
  for(const delta of [{MOSAIC_TEAMS_ALLOWED_USER_IDS:''},{MOSAIC_TEAMS_ALLOWED_USER_IDS:'*'},
    {MOSAIC_TEAMS_ALLOWED_USER_IDS:recipientId+','+recipientId},{MOSAIC_TEAMS_GROUP_CHAT_ID:''}]) {
    const result=await run('group',{...groupEnv,...delta});assert.equal(result.requests.length,0);
    assert.equal(result.event.reason,'invalid_group_binding');
  }
});

for (const scenario of ['mfa', 'consent']) test(`Teams ${scenario} failure is retained without another password attempt`, async () => {
  const result = await run(scenario);
  assert.equal(result.requests.length, 1);
  assert.equal(result.event.stage, 'failed');
  assert.equal(result.exitCode, 2);
  assert.match(result.event.events[0].description, /\[REDACTED\]/);
});

test('Teams invalid credential JSON and invalid recipient make no network requests', async () => {
  for (const [scenario, config] of [['invalid-json', {}], ['send', { MOSAIC_TEAMS_RECIPIENT_ID: 'person@example.invalid' }]]) {
    const result = await run(scenario, config);
    assert.equal(result.requests.length, 0);
    assert.equal(result.event.stage, 'failed');
  }
});

test('Teams authenticated identity mismatch stops before creating a chat', async () => {
  const result = await run('wrong-sender');
  assert.equal(result.requests.length, 2);
  assert.equal(result.event.reason, 'authenticated_identity_mismatch');
});

test('Teams graph errors retain diagnostic structure and redact escaped credentials', async () => {
  const result = await run('graph-error');
  assert.equal(result.requests.length, 3);
  assert.equal(result.event.events.at(-1).response.error.code, 'Forbidden');
  assert.match(result.event.events.at(-1).response.error.message, /REDACTED/);
});

test('Teams missing message receipt is an unconfirmed result, without resending', async () => {
  const result = await run('missing-message-id');
  assert.equal(result.requests.filter(r => r.url.endsWith('/messages')).length, 1);
  assert.equal(result.event.stage, 'failed');
  assert.equal(result.event.reason, 'message_submission_unconfirmed');
});

test('Teams Kubernetes runner validates private inputs and resource ownership', () => {
  const filename = fileURLToPath(new URL('./teams_graph_probe/test_run.py', import.meta.url));
  execFileSync('python3', [filename], { encoding: 'utf8' });
});
