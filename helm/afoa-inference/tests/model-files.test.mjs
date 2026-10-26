// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

for (const name of ['afoa-inference', 'mosaic-stack']) {
  const chart = fileURLToPath(new URL(`../../${name}`, import.meta.url));
  const prefix = name === 'mosaic-stack' ? 'llm.vllm.' : '';
  const render = (...args) => execFileSync('helm', ['template', 'trial', chart, '--show-only', 'templates/vllm.yaml', ...args], { encoding: 'utf8' });
  test(`${name}: optional model artifacts share the server image and require a revision`, () => {
    assert.doesNotMatch(render(), /initContainers:|name: model-files/);
    assert.ok(render().includes('enable_thinking\\":false'));
    for (const enabled of [true, false]) {
      const output = render('--set', `${prefix}chatTemplateKwargs.enable_thinking=${enabled}`);
      assert.ok(output.includes(`enable_thinking\\":${enabled}`));
    }
    for (const revision of ['checkpoint-one', 'checkpoint-two']) {
      const output = render('--set', `${prefix}modelRevision=${revision},${prefix}modelFiles[0]=parser.py,${prefix}extraEnv[0].name=MODEL_SETTING,${prefix}extraEnv[0].value=enabled`);
      assert.match(output, new RegExp(`--revision\\s+- "${revision}"`));
      assert.match(output, /mountPath: \/model-files\s+readOnly: true/);
      assert.match(output, /name: MODEL_SETTING\s+value: enabled/);
      const images = [...output.matchAll(/image: "([^"]+)"/g)].map(match => match[1]);
      assert.equal(images.length, 2);
      assert.equal(images[0], images[1]);
    }
    const result = spawnSync('helm', ['template', 'trial', chart, '--set', `${prefix}modelFiles[0]=parser.py`], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /modelRevision is required/);
  });
  test(`${name}: Bolt override selects its own checkpoint, parser and single GPU`, () => {
    const filename = name === 'mosaic-stack' ? 'vllm-bolt-74b-bf16-1gpu.yaml' : 'bolt-74b-bf16-1gpu.yaml';
    const output = render('-f', `${chart}/profiles/${filename}`);
    assert.match(output, /NVIDIA-Nemotron-3.5-Bolt-74B-A9B-BF16/);
    assert.match(output, /--reasoning-parser=ultra_v3/);
    assert.match(output, /--tensor-parallel-size=1/);
    assert.doesNotMatch(output, /--reasoning-parser=nemotron_v3/);
  });
}
