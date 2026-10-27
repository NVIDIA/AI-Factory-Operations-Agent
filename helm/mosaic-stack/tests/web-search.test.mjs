// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {toolRequiresEdit} from '../files/openclaw-seed/extensions/automation-context.ts';

const chart = fileURLToPath(new URL('..', import.meta.url));
const enabled = ['--set', 'modules.webSearch.enabled=true', '--set', 'webSearch.existingSecret=search-credentials'];
const render = (...args) => execFileSync('helm', ['template', 'mosaic', chart, ...args], {encoding:'utf8'});
function config(...args) {
  const seed = render(...args, '--show-only', 'templates/openclaw-seed-configmap.yaml');
  const lines = seed.split('  openclaw.json: |-\n')[1].split('\n');
  const end = lines.findIndex(line => line && !line.startsWith('    '));
  return JSON.parse(lines.slice(0, end).map(line => line.slice(4)).join('\n'));
}

test('unselected module preserves existing native search defaults and credentials', () => {
  const baseline = config();
  assert.equal(baseline.tools.web, undefined);
  assert.ok(!baseline.plugins.allow.includes('brave'));
  assert.equal(baseline.plugins.entries.brave, undefined);
  assert.doesNotMatch(render('--show-only', 'templates/openclaw.yaml'), /BRAVE_API_KEY/);
});

test('enables native search and keeps every existing tool available in sandboxed sessions', () => {
  const baseline = config();
  const search = config(...enabled);
  assert.deepEqual(search.tools.web.search, {enabled:true, provider:'brave'});
  assert.equal(search.plugins.entries.brave.enabled, true);
  assert.equal(search.plugins.entries.brave.config.webSearch.apiKey, '${BRAVE_API_KEY}');
  for (const [before, after] of [
    [baseline.tools.alsoAllow, search.tools.alsoAllow],
    [baseline.tools.sandbox.tools.alsoAllow, search.tools.sandbox.tools.alsoAllow],
    [baseline.plugins.allow, search.plugins.allow],
  ]) for (const entry of before) assert.ok(after.includes(entry));
  assert.ok(search.plugins.allow.includes('brave'));
  assert.ok(search.tools.alsoAllow.includes('web_search'));
  assert.ok(search.tools.sandbox.tools.alsoAllow.includes('web_search'));
  assert.equal(toolRequiresEdit('web_search'), false);
});

test('injects search credentials from the selected Secret and key', () => {
  for (const key of ['BRAVE_API_KEY', 'api-key']) {
    const runtime = render(...enabled, '--set', `webSearch.apiKeySecretKey=${key}`, '--show-only', 'templates/openclaw.yaml');
    assert.match(runtime, new RegExp(`name: BRAVE_API_KEY\\s+valueFrom:\\s+secretKeyRef:\\s+name: "search-credentials"\\s+key: "${key}"`));
  }
});

test('rejects incomplete web search configurations', () => {
  for (const setting of ['webSearch.existingSecret=', 'webSearch.apiKeySecretKey=', 'modules.execution.enabled=false', 'openclaw.enabled=false']) {
    const result = spawnSync('helm', ['template', 'mosaic', chart, ...enabled, '--set', setting], {encoding:'utf8'});
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /web search|modules.webSearch.enabled/);
  }
});
