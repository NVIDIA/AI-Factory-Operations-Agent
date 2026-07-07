// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  blocksAutomationTool,
  isReadonlyAutomationSession,
  readonlyAutomationSource,
} from "../files/openclaw-seed/extensions/automation-context.ts";

for (const [sessionKey, source] of [
  ["mosaic-automation-cluster-monitor-thor", "cluster-monitor"],
  ["agent:default:mosaic-automation-alert-gpu-hot", "alert"],
]) {
  test(`recognizes ${source} automation`, () => {
    assert.equal(readonlyAutomationSource(sessionKey), source);
    assert.equal(isReadonlyAutomationSession(sessionKey), true);
  });
}

test("does not trust unrelated session names", () => {
  for (const sessionKey of [undefined, "main", "automation-alert-x", "mosaic-automation-unknown-x"]) {
    assert.equal(isReadonlyAutomationSession(sessionKey), false);
  }
});

test("blocks generic mutation tools only in automation sessions", () => {
  const sessionKey = "agent:default:mosaic-automation-cluster-monitor-local";
  for (const tool of ["exec", "write", "edit", "apply_patch", "run_remote_ssh", "bcm_add_note", "bcm_remove_note"]) {
    assert.equal(blocksAutomationTool(tool, sessionKey), true, tool);
    assert.equal(blocksAutomationTool(tool, "agent:default:interactive"), false, tool);
  }
  assert.equal(blocksAutomationTool("run_kubectl", sessionKey), false);
  assert.equal(blocksAutomationTool("bcm_execute_cmsh", sessionKey), false);
});
