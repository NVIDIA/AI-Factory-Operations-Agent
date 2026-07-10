// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { installSlackApprovalBroker } from "../files/openclaw-seed/extensions/automation-guard/slack-approval.ts";

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
  const broker = installSlackApprovalBroker(api, ["UEDIT"]);
  const decision = broker(
    { mode: "edit", provider: "slack", senderId: "UEDIT" },
    { title: "Apply ConfigMap", description: "kubectl apply -f -", timeoutMs: 1000 },
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
  assert.deepEqual(edits, [{ text: "Action approved.", blocks: [] }]);
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
