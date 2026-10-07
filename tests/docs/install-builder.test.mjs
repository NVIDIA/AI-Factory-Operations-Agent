// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildCommand, enabledModules} from '../../docs/_static/install-builder.mjs';
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
  {modules:['kubernetes','observability','grafana','bcm','slurm','diagnostics','research','terminal','edit','clusters']},
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
test('pinning replaces the development selector and storage overrides are optional', () => {
  assert.ok(!argumentsFor({...example,modules:[]}).some(arg=>arg.startsWith('openclaw.pvc.storageClassName=')));
  const args=argumentsFor({...example,modules:[],version:'0.0.1',storageClass:'workspace-storage'});
  assert.ok(!args.includes('--devel'));assert.ok(args.includes('0.0.1'));
  assert.ok(args.includes('openclaw.pvc.storageClassName=workspace-storage'));
  assert.ok(args.includes('mosaicUi.auditPvc.storageClassName=workspace-storage'));
});
