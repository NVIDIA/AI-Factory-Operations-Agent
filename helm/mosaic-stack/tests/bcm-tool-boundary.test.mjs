// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const plugin = readFileSync(
  new URL("../files/openclaw-seed/extensions/bcm/index.ts", import.meta.url),
  "utf8",
);
const adapter = readFileSync(new URL("../files/bcm-mcp-ssh-adapter-http.py", import.meta.url), "utf8");

test("keeps readonly and admin CMSH on separate tools and identities", () => {
  assert.match(plugin, /name: "bcm_execute_cmsh"[\s\S]*?"execute_cmsh"/);
  assert.match(plugin, /name: "bcm_execute_cmsh_admin"[\s\S]*?"execute_cmsh_admin"/);
  assert.match(plugin, /if \(config\.editEnabled && config\.cmshEnabled\) registerTool/);
  assert.doesNotMatch(plugin, /classifyCmshRequest/);
  assert.doesNotMatch(plugin, /request\.mutating/);
});

test("requires approval for BCM mutation tools", () => {
  const start = plugin.indexOf("api.registerTrustedToolPolicy");
  const hook = plugin.slice(start, plugin.indexOf("registerTool({", start));
  assert.match(hook, /bcm_add_note.*bcm_execute_cmsh_admin.*bcm_remove_note/s);
  assert.match(hook, /requireApproval:/);
  assert.match(hook, /timeoutBehavior: "deny"/);
  assert.doesNotMatch(hook, /bcm_execute_cmsh"/);
});

test("uses per-session Auto to skip BCM approvals without weakening automation", () => {
  assert.match(plugin, /sessionSkipsApproval\(/);
  assert.match(plugin, /isReadonlyAutomationSession\(context\.sessionKey\)/);
});

test("retains the authenticated admin backend without readonly fallback", () => {
  assert.match(adapter, /def _run_cmsh_admin/);
  assert.match(adapter, /MOSAIC_BCM_CMSH_ADMIN_ENABLED/);
  assert.match(adapter, /StaticTokenVerifier/);
  assert.doesNotMatch(adapter, /_run_cmsh_admin[\s\S]*?su\s+-/);
});
