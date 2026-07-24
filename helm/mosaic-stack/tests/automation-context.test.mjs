// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  clearRunAccess,
  configureIdentityApprovalBroker,
  contextAllowsEdit,
  contextSkipsApproval,
  isReadonlyAutomationSession,
  requestIdentityApproval,
  readonlyAutomationSource,
  runAccessIdentity,
  runAccessMode,
  sessionAccessExtension,
  sessionAccessMode,
  sessionAllowsEdit,
  sessionSkipsApproval,
  setRunAccess,
  toolRequiresEdit,
} from "../files/openclaw-seed/extensions/automation-context.ts";

for (const [sessionKey, source] of [
  ["mosaic-automation-cluster-monitor-production", "cluster-monitor"],
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

test("defaults conversations to view and never enables automation edits", () => {
  assert.equal(sessionAccessMode(undefined), "view");
  assert.equal(sessionAccessMode({ mode: "view" }), "view");
  assert.equal(sessionAccessMode({ mode: "edit" }), "edit");
  assert.equal(sessionAccessMode({ mode: "auto" }), "auto");
  assert.equal(sessionAllowsEdit("agent:default:interactive", { mode: "edit" }), true);
  assert.equal(sessionAllowsEdit("agent:default:interactive", { mode: "auto" }), true);
  assert.equal(sessionSkipsApproval("agent:default:interactive", { mode: "edit" }), false);
  assert.equal(sessionSkipsApproval("agent:default:interactive", { mode: "auto" }), true);
  assert.equal(sessionAllowsEdit("agent:default:interactive", undefined), false);
  assert.equal(sessionAllowsEdit("agent:default:mosaic-automation-cluster-monitor-local", { mode: "edit" }), false);
  assert.equal(sessionSkipsApproval("agent:default:mosaic-automation-cluster-monitor-local", { mode: "auto" }), false);
});

test("uses verified Slack identity access without changing non-Slack sessions", async () => {
  const slack = { runId: "run-slack", sessionKey: "agent:default:slack" };
  const web = {
    sessionKey: "agent:default:web",
    getSessionExtension: () => ({ mode: "auto" }),
  };
  setRunAccess(slack.runId, { mode: "edit", provider: "slack", senderId: "U22222222" });
  assert.equal(runAccessMode(slack), "edit");
  assert.deepEqual(runAccessIdentity(slack), {
    mode: "edit",
    provider: "slack",
    senderId: "U22222222",
  });
  assert.equal(contextAllowsEdit(slack), true);
  assert.equal(contextSkipsApproval(slack), false);
  assert.equal(runAccessMode(web), "auto");
  assert.equal(contextSkipsApproval(web), true);

  configureIdentityApprovalBroker(async (access) => access.senderId === "U22222222" ? "allow" : "deny");
  assert.equal(await requestIdentityApproval(slack, { title: "Change", description: "Exact operation" }), "allow");
  assert.equal(await requestIdentityApproval(web, { title: "Change", description: "Exact operation" }), undefined);
  configureIdentityApprovalBroker(undefined);
  clearRunAccess(slack.runId);
  assert.equal(runAccessMode(slack), "view");
});

test("fails closed when a Slack Edit run has no identity approval broker", async () => {
  setRunAccess("run-no-broker", { mode: "edit", provider: "slack", senderId: "U22222222" });
  configureIdentityApprovalBroker(undefined);
  assert.equal(
    await requestIdentityApproval(
      { runId: "run-no-broker" },
      { title: "Change", description: "Exact operation" },
    ),
    "deny",
  );
  clearRunAccess("run-no-broker");
});

test("projects and registers access state in every approval-owning plugin", () => {
  assert.deepEqual(sessionAccessExtension.project({ state: { mode: "auto" } }), { mode: "auto" });
  for (const plugin of ["automation-guard", "kubernetes", "bcm", "remote-ssh"]) {
    const source = readFileSync(
      new URL(`../files/openclaw-seed/extensions/${plugin}/index.ts`, import.meta.url),
      "utf8",
    );
    assert.match(source, /registerSessionExtension\(sessionAccessExtension\)/, plugin);
  }
});

test("uses fixed tool capabilities with a narrow diagnostic exception", () => {
  for (const tool of [
    "write", "edit", "apply_patch",
    "run_kubectl_admin", "bcm_execute_cmsh_admin", "bcm_add_note", "bcm_remove_note",
  ]) {
    assert.equal(toolRequiresEdit(tool), true, tool);
  }
  assert.equal(toolRequiresEdit("run_kubectl"), false);
  assert.equal(toolRequiresEdit("bcm_execute_cmsh"), false);
  assert.equal(toolRequiresEdit("observability_query"), false);
  assert.equal(toolRequiresEdit("exec", { command: "nvidia-smi -L" }), false);
  assert.equal(toolRequiresEdit("exec", { command: "touch /tmp/changed" }), true);
  assert.equal(toolRequiresEdit("run_remote_ssh", { host: "node-1", argv: ["ipmitool", "mc", "info"] }), false);
  assert.equal(toolRequiresEdit("run_remote_ssh", { host: "node-1", argv: ["reboot"] }), true);
});
