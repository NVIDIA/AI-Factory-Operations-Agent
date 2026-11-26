// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import test from "node:test";

const extension = readFileSync(
  new URL("../files/openclaw-seed/extensions/diagnostic-agent/index.ts", import.meta.url),
  "utf8",
);
test("routes Hardware Agent requests through the hardware backend", () => {
  assert.match(extension, /fetchJson\(config, "\/api\/v1\/analyze-dut"/);
  assert.match(extension, /name: "hardware_triage_list"/);
  assert.match(extension, /`\/api\/v1\/triages\?limit=\$\{limit\}`/);
  assert.match(extension, /response\.map\(triageSummary\)/);
  assert.match(extension, /dut_id: dut\.id \|\| triage\.dut_id,/);
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

test("lists the DUT of each recent triage from either record layout", async t => {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      return specifier === "openclaw/plugin-sdk/plugin-entry"
        ? { url: "data:text/javascript,export const definePluginEntry = entry => entry;", shortCircuit: true }
        : next(specifier, context);
    },
  });
  const { default: plugin } = await import("../files/openclaw-seed/extensions/diagnostic-agent/index.ts");
  hooks.deregister();

  // The runtime stores dut_id and event_summary at the top level; earlier services nested the request.
  const records = [
    { triage_id: "triage-1", status: "complete", dut_id: "dgx-01", event_summary: "Xid 79", submitted_at: "2026-11-16T08:00:00+00:00" },
    { triage_id: "triage-2", status: "queued", request: { dut: { id: "dgx-02" }, event_text: "Fan fault" }, dut_id: "ignored" },
    { triage_id: "triage-3", status: "failed", error: "NVDebug collection timed out" },
  ];
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, key: request.headers["x-api-key"] });
    request.resume();
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url.startsWith("/api/v1/triages") ? records : {}));
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const tools = {};
  plugin.register({
    pluginConfig: { baseUrl, apiKey: "test-only", subagentEventsUrl: `${baseUrl}/events` },
    registerTool: tool => { tools[tool.name] = tool; },
  });
  const result = await tools.hardware_triage_list.execute("test", { limit: 3 });
  assert.deepEqual(result.details.map(({ triage_id, dut_id, event_text, error }) => ({ triage_id, dut_id, event_text, error })), [
    { triage_id: "triage-1", dut_id: "dgx-01", event_text: "Xid 79", error: undefined },
    { triage_id: "triage-2", dut_id: "dgx-02", event_text: "Fan fault", error: undefined },
    { triage_id: "triage-3", dut_id: undefined, event_text: undefined, error: "NVDebug collection timed out" },
  ]);
  assert.deepEqual(requests.find(request => request.url.startsWith("/api/v1/triages")), {
    url: "/api/v1/triages?limit=3", key: "test-only",
  });
});
