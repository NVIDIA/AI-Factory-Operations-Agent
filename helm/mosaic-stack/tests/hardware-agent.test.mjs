// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
