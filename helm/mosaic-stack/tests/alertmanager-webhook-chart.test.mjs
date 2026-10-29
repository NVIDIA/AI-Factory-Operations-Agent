// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const chart = fileURLToPath(new URL('..', import.meta.url));
const enabled = ['--set', 'alertmanagerWebhook.enabled=true',
  '--set', 'alertmanagerWebhook.auth.existingSecret=alertmanager-inbound'];
function render(...args) {
  return execFileSync('helm', ['template', 'mosaic', chart, '-n', 'mosaic-test', ...args], { encoding: 'utf8' });
}

test('webhook resources are absent by default', () => {
  assert.doesNotMatch(render(), /name: mosaic-alertmanager-webhook/);
});

test('enabling the webhook packages executable source and independent Secret references', () => {
  const output = render(...enabled, '--set', 'mosaicUi.auth.existingSecret=ui-auth-existing',
    '--set', 'alertmanagerWebhook.auth.tokenKey=inboundToken',
    '--show-only', 'templates/alertmanager-webhook.yaml');
  assert.match(output, /kind: ConfigMap/);
  assert.match(output, /kind: Deployment/);
  assert.match(output, /kind: Service/);
  assert.doesNotMatch(output, /kind: Ingress/);
  assert.match(output, /name: MOSAIC_ALERTMANAGER_WEBHOOK_TOKEN\s+valueFrom:\s+secretKeyRef:\s+name: "alertmanager-inbound"\s+key: "inboundToken"/);
  assert.match(output, /name: MOSAIC_UI_MACHINE_TOKEN\s+valueFrom:\s+secretKeyRef:\s+name: "ui-auth-existing"\s+key: machineToken/);
  assert.match(output, /name: MOSAIC_UI_URL\s+value: "http:\/\/mosaic-ui:3000"/);
  assert.match(output, /command: \["node", "\/receiver\/receiver.mjs"\]/);
  assert.match(output, /automountServiceAccountToken: false/);
  assert.match(output, /readOnlyRootFilesystem: true/);
  assert.match(output, /runAsNonRoot: true/);
  assert.match(output, /runAsUser: 1000/);
  const source = readFileSync(new URL('../files/alertmanager-webhook.mjs', import.meta.url), 'utf8');
  assert.ok(output.includes(source.trimEnd().split('\n').map(line => `    ${line}`).join('\n')));
  assert.match(output, /checksum\/receiver: [a-f0-9]{64}/);
});

test('optional ingress uses TLS and exposes only the exact webhook route', () => {
  const output = render(...enabled,
    '--set', 'alertmanagerWebhook.ingress.enabled=true',
    '--set', 'alertmanagerWebhook.ingress.host=alerts.example.com',
    '--set', 'alertmanagerWebhook.ingress.className=nginx',
    '--set', 'alertmanagerWebhook.ingress.tlsSecretName=alertmanager-tls',
    '--set', 'alertmanagerWebhook.service.port=3304',
    '--show-only', 'templates/alertmanager-webhook.yaml');
  const ingress = output.slice(output.lastIndexOf('kind: Ingress'));
  assert.match(ingress, /ingressClassName: "nginx"/);
  assert.match(ingress, /tls:\s+- hosts: \["alerts.example.com"\]\s+secretName: "alertmanager-tls"/);
  assert.match(ingress, /path: \/api\/alertmanager\/webhook\s+pathType: Exact/);
  assert.match(ingress, /name: mosaic-alertmanager-webhook\s+port:\s+number: 3304/);
  assert.doesNotMatch(ingress, /name: mosaic-ui/);
});

test('validates UI availability, single-process storage, credentials, ingress, and ports', () => {
  const cases = [
    [['--set', 'modules.ui.enabled=false'], /requires modules.ui.enabled and mosaicUi.enabled/],
    [['--set', 'mosaicUi.enabled=false'], /requires modules.ui.enabled and mosaicUi.enabled/],
    [['--set', 'mosaicUi.replicaCount=2'], /replicaCount=1/],
    [['--set', 'alertmanagerWebhook.auth.existingSecret='], /requires existingSecret/],
    [['--set', 'alertmanagerWebhook.auth.tokenKey='], /requires existingSecret/],
    [['--set', 'alertmanagerWebhook.service.port=80'], /between 1024 and 65535/],
    [['--set', 'alertmanagerWebhook.service.port=70000'], /between 1024 and 65535/],
    [['--set', 'alertmanagerWebhook.ingress.enabled=true'], /requires host and tlsSecretName/],
    [['--set', 'alertmanagerWebhook.ingress.enabled=true',
      '--set', 'alertmanagerWebhook.ingress.host=alerts.example.com'], /requires host and tlsSecretName/],
  ];
  for (const [args, message] of cases) {
    const result = spawnSync('helm', ['template', 'mosaic', chart, ...enabled, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, args.join(' '));
    assert.match(result.stderr, message);
  }
});
