// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const chart = fileURLToPath(new URL('..', import.meta.url));
const docs = fileURLToPath(new URL('../../../docs', import.meta.url));
const settings = { enabled: true, issuerUrl: 'https://identity.example.com/realms/operations', clientId: 'mosaic',
  redirectUri: 'https://mosaic.example.com/api/auth/oidc/callback', operatorGroups: ['/mosaic/operators', '/another/team'],
  existingSecret: 'site-oidc-client', clientSecretKey: 'clientSecret' };
function args(oidc) {
  return { input: JSON.stringify({ mosaicUi: { auth: { create: false, existingSecret: 'existing-local-account', oidc } } }), encoding: 'utf8' };
}
function render(oidc) {
  const yaml = execFileSync('helm', ['template', 'test', chart, '--show-only', 'templates/mosaic-ui.yaml', '-f', '-'], args(oidc));
  return JSON.parse(execFileSync('uv', ['run', '--project', docs, '--locked', 'python', '-c',
    'import json,sys,yaml;print(json.dumps(list(yaml.safe_load_all(sys.stdin))))'], { input: yaml, encoding: 'utf8' }));
}
const workload = resources => resources.find(item => item.kind === 'Deployment');

test('OIDC is opt-in and preserves the local account, runtime, audit storage and Service', () => {
  const baseline = render({ enabled: false });
  const configured = render(settings);
  const before = workload(baseline).spec.template.spec;
  const after = workload(configured).spec.template.spec;
  const env = after.containers[0].env;
  assert.equal(before.containers[0].env.some(item => item.name.startsWith('MOSAIC_OIDC_')), false);
  for (const entry of before.containers[0].env) assert.deepEqual(env.find(item => item.name === entry.name), entry);
  assert.equal(after.containers[0].image, before.containers[0].image);
  assert.deepEqual(after.volumes, before.volumes);
  assert.deepEqual(after.containers[0].volumeMounts, before.containers[0].volumeMounts);
  assert.deepEqual(configured.find(item => item.kind === 'Service'), baseline.find(item => item.kind === 'Service'));
  assert.equal(env.find(item => item.name === 'MOSAIC_OIDC_ISSUER').value, settings.issuerUrl);
  assert.deepEqual(JSON.parse(env.find(item => item.name === 'MOSAIC_OIDC_OPERATOR_GROUPS').value), settings.operatorGroups);
  assert.deepEqual(env.find(item => item.name === 'MOSAIC_OIDC_CLIENT_SECRET').valueFrom.secretKeyRef,
    { name: settings.existingSecret, key: settings.clientSecretKey });
});

test('optional trusted CA is mounted read-only without replacing existing trust or local authentication', () => {
  const pod = workload(render({ ...settings, caCertificateSecret: 'site-idp-ca', caCertificateKey: 'issuer.pem' })).spec.template.spec;
  const container = pod.containers[0];
  const location = container.env.find(item => item.name === 'NODE_EXTRA_CA_CERTS').value;
  const mount = container.volumeMounts.find(item => location.startsWith(item.mountPath + '/'));
  assert.equal(mount.readOnly, true);
  const volume = pod.volumes.find(item => item.name === mount.name);
  assert.equal(volume.secret.secretName, 'site-idp-ca');
  assert.deepEqual(volume.secret.items, [{ key: 'issuer.pem', path: 'ca.crt' }]);
  assert.ok(container.env.some(item => item.name === 'MOSAIC_UI_PASSWORD'));
  assert.equal(container.env.some(item => item.name === 'NODE_TLS_REJECT_UNAUTHORIZED'), false);
});

test('enabled OIDC requires HTTPS, an exact callback, Secret references and explicit operator bindings', () => {
  for (const override of [{ issuerUrl: 'http://identity.example.com/realms/operations' }, { issuerUrl: 'https://user:password@identity.example.com' },
    { redirectUri: 'https://mosaic.example.com/elsewhere' }, { redirectUri: 'http://mosaic.example.com/api/auth/oidc/callback' },
    { clientId: '' }, { existingSecret: '' }, { clientSecretKey: '' }, { operatorGroups: [] }, { operatorGroups: [''] },
    { operatorGroups: ['operators', 42] }, { caCertificateSecret: 'site-ca', caCertificateKey: '' }]) {
    const result = spawnSync('helm', ['template', 'test', chart, '-f', '-'], args({ ...settings, ...override }));
    assert.notEqual(result.status, 0);
  }
});
