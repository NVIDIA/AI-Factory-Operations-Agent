// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  diagnosticExecArgv,
  isAllowedDiagnosticArgv,
} from "../files/openclaw-seed/extensions/diagnostic-policy.ts";

test("allows bounded read-only diagnostic argv", () => {
  for (const argv of [
    ["hostname"],
    ["uname", "-r"],
    ["nvidia-smi", "--query-gpu=name,driver_version,vbios_version", "--format=csv"],
    ["ipmitool", "mc", "info"],
    ["journalctl", "-u", "slurmd", "-n", "100", "--no-pager"],
    ["systemctl", "status", "slurmd", "--no-pager"],
    ["scontrol", "show", "nodes"],
    ["ibstat"],
  ]) assert.equal(isAllowedDiagnosticArgv(argv), true, argv.join(" "));
});

test("rejects mutation flags, arbitrary programs, paths, and shell syntax", () => {
  for (const argv of [
    ["nvidia-smi", "-pm", "1"],
    ["ipmitool", "chassis", "power", "off"],
    ["systemctl", "restart", "slurmd"],
    ["journalctl", "--rotate"],
    ["dmesg", "-c"],
    ["ss", "-K"],
    ["scontrol", "update", "NodeName=n1", "State=DOWN"],
    ["cat", "/etc/shadow"],
    ["/usr/bin/hostname"],
    ["hostname", ";", "touch", "/tmp/pwned"],
  ]) assert.equal(isAllowedDiagnosticArgv(argv), false, argv.join(" "));
});

test("parses only a bare safe exec command", () => {
  assert.deepEqual(diagnosticExecArgv({ command: "nvidia-smi -L" }), ["nvidia-smi", "-L"]);
  for (const params of [
    { command: "hostname && touch /tmp/pwned" },
    { command: "systemctl restart slurmd" },
    { command: "hostname", workdir: "/tmp" },
    { command: "'hostname'" },
    { command: "/usr/bin/hostname" },
  ]) assert.equal(diagnosticExecArgv(params), undefined);
});
