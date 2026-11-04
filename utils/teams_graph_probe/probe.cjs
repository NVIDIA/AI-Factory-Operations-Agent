// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Isolated Graph delegated diagnostic. Passwords and tokens are never emitted.
'use strict';
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const credentialPath = process.env.MOSAIC_TEAMS_CREDENTIAL_FILE || '/var/run/mosaic-teams/credentials.json';
const runId = process.env.MOSAIC_TEST_RUN_ID;
const probeMode = process.env.MOSAIC_TEST_PROBE_MODE || 'identity';
const recipient = process.env.MOSAIC_TEAMS_RECIPIENT_ID || '';
const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const startedAt = new Date().toISOString();
const events = [];
let protectedValues = [];

function scrub(value) {
  let result = String(value ?? '');
  for (const secret of protectedValues) {
    if (!secret) continue;
    const variants = [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret),
      new URLSearchParams({ value: secret }).toString().slice(6)];
    for (const variant of [...new Set(variants)].sort((a, b) => b.length - a.length)) {
      result = result.split(variant).join('[REDACTED]');
    }
  }
  return result;
}

function emit(value) {
  process.stdout.write(scrub(JSON.stringify(value)) + '\n');
}

async function readCredentials() {
  let raw;
  try { raw = await fs.readFile(credentialPath, 'utf8'); }
  catch { throw new Error('credential_file_unreadable'); }
  let credentials;
  try { credentials = JSON.parse(raw); }
  catch { throw new Error('credential_file_invalid_json'); }
  for (const key of ['username', 'password', 'clientId', 'tenantId']) {
    if (typeof credentials[key] !== 'string' || !credentials[key]) {
      throw new Error('credential_field_missing_' + key);
    }
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(credentials.username)) {
    throw new Error('invalid_user_principal_name');
  }
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(credentials.clientId)) {
    throw new Error('invalid_application_id');
  }
  if (!/^(?:organizations|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|[a-z0-9.-]+\.onmicrosoft\.com)$/i.test(credentials.tenantId)) {
    throw new Error('invalid_tenant_id');
  }
  protectedValues = [credentials.password, credentials.clientSecret].filter(Boolean);
  const info = await fs.stat(credentialPath);
  return { credentials, file: { mode: (info.mode & 0o777).toString(8), uid: info.uid,
    gid: info.gid, bytes: info.size, modifiedAt: info.mtime.toISOString() } };
}

async function authenticate() {
  // Reopen the projected file immediately before each new password login.
  const { credentials: c, file } = await readCredentials();
  const endpoint = `https://login.microsoftonline.com/${c.tenantId}/oauth2/v2.0/token`;
  const fields = { client_id: c.clientId, grant_type: 'password', username: c.username,
    password: c.password, scope: probeMode === 'identity'
      ? 'https://graph.microsoft.com/User.Read'
      : 'https://graph.microsoft.com/User.Read https://graph.microsoft.com/Chat.Create https://graph.microsoft.com/ChatMessage.Send' };
  if (c.clientSecret) fields.client_secret = c.clientSecret;
  const response = await fetch(endpoint, { method: 'POST', body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  const event = { step: 'entra_login', httpStatus: response.status, endpoint,
    credentialFile: file, username: c.username, clientId: c.clientId,
    requestedScopes: fields.scope, clientSecretProvided: Boolean(c.clientSecret) };
  if (!response.ok || !data.access_token) {
    // invalid_grant has several causes. Never retry passwords or reset the account here.
    event.error = data.error;
    event.errorCodes = data.error_codes;
    event.suberror = data.suberror;
    event.traceId = data.trace_id;
    event.correlationId = data.correlation_id;
    event.timestamp = data.timestamp;
    event.description = scrub(data.error_description);
    events.push(event);
    throw new Error('entra_login_failed');
  }
  protectedValues.push(data.access_token, data.refresh_token, data.id_token);
  events.push({ ...event, grantedScopes: data.scope, expiresIn: data.expires_in,
    tokenType: data.token_type, passwordLoginAttempts: 1 });
  return { token: data.access_token, username: c.username };
}

async function graph(token, method, path, body) {
  const clientRequestId = crypto.randomUUID();
  const response = await fetch('https://graph.microsoft.com/v1.0' + path, {
    method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
      'client-request-id': clientRequestId }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000) });
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (data.error) {
    events.push({ step: 'graph_request', method, path, httpStatus: response.status,
      clientRequestId, response: JSON.parse(scrub(JSON.stringify(data))) });
    throw new Error('graph_request_failed');
  }
  events.push({ step: 'graph_request', method, path, httpStatus: response.status,
    clientRequestId, requestId: response.headers.get('request-id') });
  if (!response.ok) throw new Error('graph_http_failed');
  return data;
}

async function main() {
  if (!/^[a-z0-9-]+$/i.test(runId || '')) throw new Error('invalid_run_id');
  if (!['send', 'identity'].includes(probeMode)) throw new Error('invalid_probe_mode');
  if (probeMode === 'send' && !guid.test(recipient)) throw new Error('recipient_guid_required');
  const { token, username } = await authenticate();
  const me = await graph(token, 'GET', '/me?$select=id,userPrincipalName,displayName');
  if (me.userPrincipalName?.toLowerCase() !== username.toLowerCase()) {
    throw new Error('authenticated_identity_mismatch');
  }
  if (probeMode === 'identity') {
    emit({ runId, stage: 'identity_verified', startedAt, completedAt: new Date().toISOString(),
      identity: me, events, scope: 'User.Read-only identity verification; no chat request or message sent',
      passwordResetPerformed: false, passwordRotationEnabled: false });
    return;
  }
  if (!guid.test(me.id)) throw new Error('invalid_sender_guid');
  if (me.id.toLowerCase() === recipient.toLowerCase()) throw new Error('distinct_test_recipient_required');
  const chat = await graph(token, 'POST', '/chats', { chatType: 'oneOnOne', members: [
    { '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'],
      'user@odata.bind': `https://graph.microsoft.com/v1.0/users/${me.id}` },
    { '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'],
      'user@odata.bind': `https://graph.microsoft.com/v1.0/users/${recipient}` },
  ] });
  if (typeof chat.id !== 'string' || !chat.id) throw new Error('chat_id_missing');
  const content = 'MOSAIC isolated Teams delegated validation\nRun ID: ' + runId;
  const sent = await graph(token, 'POST', `/chats/${encodeURIComponent(chat.id)}/messages`,
    { body: { contentType: 'text', content } });
  if (typeof sent.id !== 'string' || !sent.id) throw new Error('message_submission_unconfirmed');
  emit({ runId, stage: 'sent', startedAt, completedAt: new Date().toISOString(),
    sender: me, recipient, chatId: chat.id, messageId: sent.id,
    createdDateTime: sent.createdDateTime, message: content, events,
    scope: 'Graph delegated service-account test; not the native OpenClaw msteams Bot channel',
    passwordRotationEnabled: false, passwordResetPerformed: false });
}

main().catch(error => {
  emit({ runId, stage: 'failed', startedAt, completedAt: new Date().toISOString(),
    reason: ['credential_file_unreadable', 'credential_file_invalid_json', 'entra_login_failed',
      'graph_request_failed', 'graph_http_failed', 'authenticated_identity_mismatch',
      'invalid_user_principal_name', 'invalid_application_id', 'invalid_tenant_id',
      'invalid_run_id', 'invalid_probe_mode', 'recipient_guid_required', 'invalid_sender_guid',
      'distinct_test_recipient_required', 'chat_id_missing', 'message_submission_unconfirmed'].includes(error.message) || error.message.startsWith('credential_field_missing_')
      ? error.message : 'probe_failed', events, passwordResetPerformed: false,
    passwordRotationEnabled: false, secretValuesLogged: false });
  process.exitCode = 2;
});
