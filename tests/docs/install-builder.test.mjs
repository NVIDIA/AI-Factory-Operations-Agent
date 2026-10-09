// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildCommand, enabledModules, modules} from '../../docs/_static/install-builder.mjs';
const chart = fileURLToPath(new URL('../../helm/mosaic-stack', import.meta.url));
function argumentsFor(state) {
  const shell = `trap '[ -z "\${MOSAIC_CHART_WORKDIR:-}" ] || rm -rf "$MOSAIC_CHART_WORKDIR"' EXIT; helm() { if [ "$1" = pull ]; then ln -s '${chart}' "$MOSAIC_CHART_WORKDIR/mosaic-stack"; else printf '%s\\0' "$@"; fi; };\n${buildCommand(state)}\nprintf '%s\\0' "\${MOSAIC_CHART_WORKDIR:-}"`;
  const result = spawnSync('bash', ['-c', shell], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  const args = result.stdout.split('\0');
  args.pop();
  const workdir = args.pop();
  return args.slice(4).map(arg => workdir ? arg.replace(`${workdir}/mosaic-stack`, chart) : arg);
}
const example = {inference:'external', baseUrl:'https://inference.example.com/v1', model:'served-model', bcmHead:'root@head.example.com',
  prometheusUrl:'http://metrics:9090', alertmanagerUrl:'http://alerts:9093', grafanaUrl:'https://dashboards.example.com/grafana',
  corpus:'/data/corpus', evidenceRoot:'/data/jobs', evidenceNode:'login-node'};
for (const state of [
  {modules:[]}, {modules:['terminal']}, {modules:['slurm']}, {modules:['slurm'], slurmBackend:'vanilla'},
  {modules:['kubernetes','prometheus','alertmanager','loki','grafana','bcm','slurm','diagnostics','research','terminal','edit','clusters']},
  {inference:'super',modules:['terminal']}, {inference:'ultra',modules:['grafana']},
]) test(`generated selection renders in Helm: ${JSON.stringify(state)}`, () => {
  const args = argumentsFor({...example, ...state});
  const renderArgs = [];
  for (let i=0; i<args.length; i++) {
    if (['--atomic','--wait','--devel'].includes(args[i])) continue;
    if (['--timeout','--version'].includes(args[i])) {i++; continue;}
    renderArgs.push(args[i]);
  }
  const result = spawnSync('helm', ['template','mosaic',chart,...renderArgs], {encoding:'utf8',maxBuffer:8*1024*1024});
  assert.equal(result.status,0,result.stderr);
});
test('dependencies are derived without changing requested modules', () => {
  const state={modules:['diagnostics','terminal'],slurmBackend:'vanilla'};
  assert.deepEqual([...enabledModules(state)].sort(),['bcm','diagnostics','kubernetes','terminal']);
  assert.deepEqual(state.modules,['diagnostics','terminal']);
});
test('shell metacharacters remain literal arguments and Helm list separators are escaped', () => {
  for(const model of ["quoted' name,revision", 'model $(printf unsafe); $HOME']) {
    const args=argumentsFor({...example,modules:[],model});
    assert.ok(args.includes(`llm.external.model=${model.replaceAll(',', '\\,')}`));
  }
});
test('pinning replaces the development selector', () => {
  const args=argumentsFor({...example,modules:[],version:'0.0.1'});
  assert.ok(!args.includes('--devel'));assert.ok(args.includes('0.0.1'));
});
test('Loki connection settings remain optional and use Secret references', () => {
  const state = {...example, modules:['loki'], lokiUrl:'https://logs.example.com/prefix',
    lokiTenant:'team-one', lokiSecret:'log-reader', lokiKey:'header'};
  const args = argumentsFor(state);
  for (const setting of ['url=https://logs.example.com/prefix', 'tenantId=team-one',
    'auth.existingSecret=log-reader', 'auth.authorizationKey=header']) {
    assert.ok(args.includes(`observability.loki.${setting}`));
  }
  const defaults = argumentsFor({...example, modules:['loki']});
  assert.ok(defaults.includes('observability.loki.url=<Loki URL>'));
  assert.ok(defaults.includes('observability.loki.auth.existingSecret='));
  assert.ok(argumentsFor({...state,modules:[]}).includes('observability.loki.url='));
});

test('builder covers every module toggle and observability connection setting', () => {
  const directory = mkdtempSync(join(tmpdir(), 'builder-values-'));
  let values;
  try {
    mkdirSync(join(directory, 'templates'));
    writeFileSync(join(directory, 'Chart.yaml'), 'apiVersion: v2\nname: values\nversion: 0.1.0\n');
    writeFileSync(join(directory, 'templates/values.yaml'), '{{ .Values | toJson }}');
    const result = spawnSync('helm', ['template', directory, '-f', join(chart, 'values.yaml')], {encoding:'utf8'});
    assert.equal(result.status, 0, result.stderr);
    values = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  } finally { rmSync(directory, {recursive:true, force:true}); }
  const moduleNames = Object.keys(values.modules);
  const args = argumentsFor({...example, modules:Object.keys(modules)});
  for (const name of moduleNames) {
    assert.ok(args.includes(`modules.${name}.enabled=true`), `Missing builder module: ${name}`);
  }
  // The form's Grafana credential contract fixes these existing Secret key names.
  const fixed = new Set(['observability.grafanaAuth.usernameKey', 'observability.grafanaAuth.passwordKey']);
  function check(object, prefix) {
    for (const [key, value] of Object.entries(object)) {
      const path = `${prefix}.${key}`;
      if (value !== null && typeof value === 'object') check(value, path);
      else assert.ok(fixed.has(path) || args.some(arg => arg.startsWith(`${path}=`)), `Missing builder connection setting: ${path}`);
    }
  }
  check(values.observability, 'observability');
});

test('each observability service is independently selectable and clears other endpoints', () => {
  const paths = {prometheus:'prometheusUrl', alertmanager:'alertmanagerUrl', loki:'loki.url'};
  for (const selected of Object.keys(paths)) {
    const args = argumentsFor({...example, modules:[selected], lokiUrl:'http://logs:3100'});
    assert.ok(args.includes('modules.observability.enabled=true'));
    for (const [service, path] of Object.entries(paths)) {
      assert.equal(args.includes(`observability.${path}=`), service !== selected);
      assert.ok(!args.some(arg => arg.startsWith(`modules.${service}.`)));
    }
  }
  assert.ok(argumentsFor({...example,modules:[]}).includes('modules.observability.enabled=false'));
});
