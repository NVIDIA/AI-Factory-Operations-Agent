// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { installSlackApprovalBroker } from "../files/openclaw-seed/extensions/automation-guard/slack-approval.ts";
import { recordApprovalDecision, runMutationOnce } from "../files/openclaw-seed/extensions/mutation-ledger.ts";

test("Slack approval buttons bind the decision to the requesting Edit user", async () => {
  let handler;
  let sent;
  const edits = [];
  const replies = [];
  const api = {
    config: {},
    registerInteractiveHandler(registration) {
      handler = registration.handler;
    },
    runtime: {
      channel: {
        outbound: {
          async loadAdapter() {
            return { async sendPayload(payload) { sent = payload; } };
          },
        },
      },
    },
  };
  const directory = mkdtempSync(path.join(tmpdir(), "mosaic-slack-approval-"));
  const ledgerPath = path.join(directory, "approvals.json");
  const broker = installSlackApprovalBroker(api, ["UEDIT"], ledgerPath);
  const decision = broker(
    { mode: "edit", provider: "slack", senderId: "UEDIT" },
    {
      toolCallId: "tool-1",
      toolName: "run_kubectl_admin",
      title: "Apply ConfigMap",
      description: "kubectl apply -f -",
      timeoutMs: 1000,
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.to, "user:UEDIT");
  assert.equal(sent.payload.presentation, undefined);
  const buttons = sent.payload.channelData.slack.blocks[1].elements;
  assert.deepEqual(buttons.map((button) => button.text.text), ["Approve", "Deny"]);
  assert.deepEqual(buttons.map((button) => button.action_id), [
    "mosaic-approval:allow",
    "mosaic-approval:deny",
  ]);
  const id = buttons[0].value;

  await handler({
    senderId: "UVIEW",
    interaction: { payload: `allow:${id}` },
    respond: { async reply(value) { replies.push(value); } },
  });
  assert.match(replies[0].text, /not authorized/);
  await handler({
    senderId: "UEDIT",
    interaction: { payload: `allow:${id}` },
    respond: { async editMessage(value) { edits.push(value); } },
  });
  assert.equal(await decision, "allow");
  assert.deepEqual(edits, [{
    text: "Apply ConfigMap\nkubectl apply -f -\nApproval: Approved by <@UEDIT>.\nExecution: Authorized.\nResult: Reported separately by the tool.",
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Apply ConfigMap*\nkubectl apply -f -" },
      },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: "*Approval:* Approved by <@UEDIT>.\n*Execution:* Authorized.\n*Result:* Reported separately by the tool.",
        }],
      },
    ],
  }]);
  assert.deepEqual(JSON.parse(readFileSync(ledgerPath, "utf8")).map(({ decidedAt, ...entry }) => entry), [{
    id: "tool-1",
    toolName: "run_kubectl_admin",
    senderId: "UEDIT",
    decision: "allow",
  }]);
  rmSync(directory, { recursive: true, force: true });
});

test("Slack approval broker denies users outside the Edit identity list", async () => {
  let sends = 0;
  const broker = installSlackApprovalBroker({
    config: {},
    registerInteractiveHandler() {},
    runtime: { channel: { outbound: { async loadAdapter() {
      return { async sendPayload() { sends += 1; } };
    } } } },
  }, ["UEDIT"]);
  assert.equal(
    await broker(
      { mode: "edit", provider: "slack", senderId: "UVIEW" },
      { title: "Change", description: "Exact operation" },
    ),
    "deny",
  );
  assert.equal(sends, 0);
});

test("keeps an approved failed attempt separate from a denied retry", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "mosaic-action-sequence-"));
  const approvalPath = path.join(directory, "approvals.json");
  const mutationPath = path.join(directory, "mutations.json");
  await recordApprovalDecision({
    id: "attempt-1",
    toolName: "bcm_execute_cmsh_admin",
    senderId: "UEDIT",
    decision: "allow",
    ledgerPath: approvalPath,
  });
  await runMutationOnce({
    toolCallId: "attempt-1",
    toolName: "bcm_execute_cmsh_admin",
    target: "bcm",
    args: "invalid command",
    ledgerPath: mutationPath,
  }, async () => ({ code: 1 }), ({ code }) => code === 0 ? "completed" : "failed");
  await recordApprovalDecision({
    id: "attempt-2",
    toolName: "bcm_execute_cmsh_admin",
    senderId: "UEDIT",
    decision: "deny",
    ledgerPath: approvalPath,
  });

  assert.deepEqual(
    JSON.parse(readFileSync(approvalPath, "utf8")).map(({ decidedAt, ...entry }) => entry),
    [
      { id: "attempt-1", toolName: "bcm_execute_cmsh_admin", senderId: "UEDIT", decision: "allow" },
      { id: "attempt-2", toolName: "bcm_execute_cmsh_admin", senderId: "UEDIT", decision: "deny" },
    ],
  );
  assert.deepEqual(
    JSON.parse(readFileSync(mutationPath, "utf8")).map(({ startedAt, finishedAt, fingerprint, ...entry }) => entry),
    [{ id: "attempt-1", state: "failed" }],
  );
  rmSync(directory, { recursive: true, force: true });
});
