// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
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
    ["lspci"],
    ["lspci", "-s", "0000:01:00.0", "-vvv"],
    ["lspci", "-vvv", "-s", "0000:01:00.0"],
    ["lspci", "-d", "10de:", "-vvv"],
    ["lspci", "-t"],
  ]) assert.equal(isAllowedDiagnosticArgv(argv), true, argv.join(" "));
});

test("rejects mutation flags, arbitrary programs, paths, and shell syntax", () => {
  for (const argv of [
    ["nvidia-smi", "-pm", "1"],
    ["ipmitool", "chassis", "power", "off"],
    ["systemctl", "restart", "slurmd"],
    ["journalctl", "--rotate"],
    ["dmesg", "-c"],
    ["lspci", "-s"],
    ["lspci", "-s", "-vvv"],
    ["ss", "-K"],
    ["scontrol", "update", "NodeName=n1", "State=DOWN"],
    ["cat", "/etc/shadow"],
    ["/usr/bin/hostname"],
    ["hostname", ";", "touch", "/tmp/pwned"],
  ]) assert.equal(isAllowedDiagnosticArgv(argv), false, argv.join(" "));
});
