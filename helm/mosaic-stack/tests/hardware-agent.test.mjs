// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extension = readFileSync(
  new URL("../files/openclaw-seed/extensions/diagnostic-agent/index.ts", import.meta.url),
  "utf8",
);
const skill = readFileSync(
  new URL("../files/openclaw-seed/skills/hardware-agent/SKILL.md", import.meta.url),
  "utf8",
);

test("routes Hardware Agent requests through the hardware backend", () => {
  assert.match(extension, /fetchJson\(config, "\/api\/v1\/analyze-dut"/);
  assert.match(extension, /name: "hardware_triage_list"/);
  assert.match(extension, /`\/api\/v1\/triages\?limit=\$\{limit\}`/);
  assert.match(extension, /response\.map\(triageSummary\)/);
  assert.doesNotMatch(extension, /DGX13_COMPLETED|knownCompletedReport|completed_report/);
  assert.doesNotMatch(skill, /1541149d-380c-4e09-af78-45dce80f8d71|use this completed Hardware Agent report/);
  assert.match(skill, /call `hardware_triage_list` first/);
  assert.match(extension, /required: \["dut"\]/);
  assert.doesNotMatch(extension, /user_confirmation|confirmsFreshCollection/);
  assert.doesNotMatch(extension, /pass it verbatim/);
  assert.match(extension, /General hardware health collection requested for \$\{displayDutId\}/);
  assert.doesNotMatch(extension, /pollTriage|pollIntervalSeconds|pollTimeoutSeconds|suppressMosaicAlertForTriage/);
  assert.match(extension, /return jsonToolResult\(\{ submitted, triage_id: triageId \}\)/);
  assert.match(skill, /Do not wait or poll in the same turn/);
  assert.doesNotMatch(skill, /"wait": true/);
  assert.match(extension, /`dgx-\$\{id\.padStart\(2, "0"\)\}`/);
  assert.match(skill, /After the mandatory duration disclosure, the user's next ordinary affirmative\s+response is sufficient/);
  assert.match(skill, /Do not demand a formal confirmation/);
  assert.match(skill, /Interpret the user's response in conversation/);
  assert.match(skill, /This is a hard requirement/);
  assert.match(skill, /A fresh NVDebug collection can take 5–30 minutes\. Do you want me to start it\?/);
  assert.match(skill, /you MUST say: 'A fresh NVDebug collection can take 5-30 minutes\. Do you want me to start it\?'/);
  assert.match(skill, /Do not invoke `hardware_analyze_dut` in the same\s+turn as the disclosure/);
  assert.match(extension, /source: "hardware-agent"/);
  assert.match(extension, /name: "NVDebug Hardware Agent"/);
  assert.match(extension, /label: "Hardware Triage Report"/);
});
