// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { runInNewContext } from "node:vm";

const extension = readFileSync(
  new URL("../files/openclaw-seed/extensions/diagnostic-agent/index.ts", import.meta.url),
  "utf8",
);

test("lookup guidance follows configuration while tools and DUT inputs stay available", async () => {
  const source = stripTypeScriptTypes(extension
    .replace('import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";', '')
    .replace('export default definePluginEntry(', 'globalThis.plugin = definePluginEntry('));
  let defaultSchema;
  for (const lookup of [undefined, 'true', 'false']) {
    const requests = [];
    const context = {
      definePluginEntry: value => value,
      process: {env: {DIAGNOSTIC_AGENT_BCM_LOOKUP_ENABLED: lookup}},
      setTimeout, clearTimeout, AbortController,
      fetch: async (url, options) => {
        requests.push({url, body: JSON.parse(options.body)});
        return {ok: true, text: async () => JSON.stringify({triage_id: 'trial-42'})};
      },
    };
    runInNewContext(source, context);
    const tools = [];
    context.plugin.register({pluginConfig: {}, registerTool: tool => tools.push(tool)});
    assert.equal(tools.length, 5);
    const analyze = tools.find(tool => tool.name === 'hardware_analyze_dut');
    const schema = JSON.stringify(analyze.parameters);
    defaultSchema ??= schema;
    assert.equal(schema, defaultSchema);
    assert.ok(analyze.description.includes(`Inventory lookup is ${lookup === 'false' ? 'disabled' : 'enabled'}`));
    if (lookup === 'false') assert.ok(analyze.description.includes('private authenticated API'));
    assert.equal(analyze.parameters.properties.dut.additionalProperties, true);
    const dut = {id: 'node-42', baseboard: 'supported-board', bmc_ip: '192.0.2.42', bmc_username: 'synthetic', bmc_password: 'synthetic-only', site_metadata: 'preserved'};
    await analyze.execute('trial-call', {dut, event_text: 'health check', profile_name: 'supported-profile'});
    const submission = requests.find(request => request.url.endsWith('/api/v1/analyze-dut'));
    assert.deepEqual(submission.body.dut, dut);
    assert.equal(submission.body.profile_name, 'supported-profile');
  }
});
test("routes Hardware Agent requests through the hardware backend", () => {
  assert.match(extension, /fetchJson\(config, "\/api\/v1\/analyze-dut"/);
  assert.match(extension, /name: "hardware_triage_list"/);
  assert.match(extension, /`\/api\/v1\/triages\?limit=\$\{limit\}`/);
  assert.match(extension, /response\.map\(triageSummary\)/);
  assert.doesNotMatch(extension, /DGX13_COMPLETED|knownCompletedReport|completed_report/);
  assert.match(extension, /required: \["dut"\]/);
  assert.doesNotMatch(extension, /user_confirmation|confirmsFreshCollection/);
  assert.doesNotMatch(extension, /pass it verbatim/);
  assert.match(extension, /General hardware health collection requested for \$\{displayDutId\}/);
  assert.doesNotMatch(extension, /pollTriage|pollIntervalSeconds|pollTimeoutSeconds|suppressMosaicAlertForTriage/);
  assert.match(extension, /return jsonToolResult\(\{ submitted, triage_id: triageId \}\)/);
  assert.match(extension, /`dgx-\$\{id\.padStart\(2, "0"\)\}`/);
  assert.match(extension, /source: "hardware-agent"/);
  assert.match(extension, /name: "NVDebug Hardware Agent"/);
  assert.match(extension, /label: "Hardware Triage Report"/);
});
