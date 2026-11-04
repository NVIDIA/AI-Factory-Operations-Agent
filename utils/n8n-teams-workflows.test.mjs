// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { workflows } from "./n8n-teams-workflows.mjs";

const senderId = "11111111-1111-4111-8111-111111111111";
const recipientId = "22222222-2222-4222-8222-222222222222";
const options = { senderId, recipientId };
function run(workflow, name, input, previous = {}) {
  const node = workflow.nodes.find((n) => n.name === name);
  return new Function("$input", "$", node.parameters.jsCode)(
    { first: () => ({ json: input }) },
    (name) => ({ first: () => ({ json: previous[name] }) }),
  )[0].json;
}
function through(action) {
  const wf = workflows(options)[action === "send" ? 0 : 1];
  const previous = {};
  const body = {
    protocol: "mosaic-teams-v1",
    action,
    recipientId,
    chatId: "",
    text: "Complete message <code> & 中文 🚀",
    deliveryId: "delivery-1",
    pageToken: "",
  };
  previous["Validate request"] = run(wf, "Validate request", {
    senderId,
    recipientId,
    body,
  });
  previous["Verify sender"] = run(
    wf,
    "Verify sender",
    { id: senderId },
    previous,
  );
  previous["Bind conversation"] = run(
    wf,
    "Bind conversation",
    { id: "19:pair@unq.gbl.spaces", chatType: "oneOnOne" },
    previous,
  );
  return { wf, body, previous };
}

test("generates inactive authenticated stateless workflows with explicit non-retrying Graph POSTs", () => {
  for (const wf of workflows(options)) {
    assert.equal(wf.active, false);
    assert.equal(wf.nodes[0].parameters.authentication, "headerAuth");
    assert.equal(wf.nodes.at(-1).parameters.respondWith, "json");
    assert.ok(
      wf.nodes.every(
        (n) => !n.type.includes("schedule") && !n.type.includes("dataTable"),
      ),
    );
    for (const n of wf.nodes.filter((n) => n.type.endsWith("httpRequest"))) {
      assert.equal(n.parameters.nodeCredentialType, "microsoftTeamsOAuth2Api");
      assert.equal(n.retryOnFail, false);
      assert.equal(
        n.parameters.options.redirect.redirect.followRedirects,
        false,
      );
    }
    assert.ok(!JSON.stringify(wf).includes("$secrets"));
  }
  assert.throws(
    () => workflows({ ...options, senderId: recipientId }),
    /Distinct/,
  );
  assert.throws(
    () => workflows({ ...options, pathPrefix: "https://bad.invalid" }),
    /prefix/,
  );
});

test("exact Code-node source confirms fixed service identity and explicit user GUID member bindings", () => {
  const { wf, body, previous } = through("send");
  const members = previous["Verify sender"].chatBody.members;
  assert.deepEqual(
    members.map((m) => m["user@odata.bind"]),
    [senderId, recipientId].map(
      (id) => "https://graph.microsoft.com/v1.0/users/" + id,
    ),
  );
  assert.equal(previous["Bind conversation"].request.text, body.text);
  const receipt = run(
    wf,
    "Confirm response",
    { id: "actual-message", createdDateTime: "2026-11-04T10:00:00Z" },
    previous,
  );
  assert.equal(receipt.messageId, "actual-message");
  assert.equal(receipt.deliveryId, "delivery-1");
  assert.throws(
    () => run(wf, "Verify sender", { id: recipientId }, previous),
    /OAuth account/,
  );
  assert.throws(
    () =>
      run(wf, "Validate request", {
        senderId,
        recipientId,
        body: { ...body, recipientId: senderId },
      }),
    /fixed recipient/,
  );
  assert.throws(
    () =>
      run(wf, "Validate request", {
        senderId,
        recipientId,
        body: { ...body, action: "read" },
      }),
    /endpoint/,
  );
  assert.throws(
    () =>
      run(wf, "Validate request", {
        senderId,
        recipientId,
        body: { ...body, text: "🚀".repeat(2001) },
      }),
    /message/,
  );
  assert.throws(
    () => run(wf, "Confirm response", { error: "failed" }, previous),
    /receipt/,
  );
});

test("read workflow validates pagination host and conversation, preserving the exact opaque token", () => {
  const { wf, previous } = through("read");
  const chatId = previous["Bind conversation"].chatId;
  const token = "opaque+A/B%=cursor";
  const link =
    "https://graph.microsoft.com/v1.0/chats/" +
    encodeURIComponent(chatId) +
    "/messages?$orderby=createdDateTime%20desc&%24skiptoken=" +
    encodeURIComponent(token);
  const page = { value: [{ id: "message-1" }], "@odata.nextLink": link };
  assert.equal(run(wf, "Confirm response", page, previous).nextToken, token);
  assert.deepEqual(
    run(wf, "Confirm response", page, previous).messages,
    page.value,
  );
  assert.equal(
    run(wf, "Confirm response", { value: [] }, previous).nextToken,
    null,
  );
  for (const changed of [
    link.replace("graph.microsoft.com", "evil.example.invalid"),
    link.replace(encodeURIComponent(chatId), "another-chat"),
    link + "&$skiptoken=second",
    link.split("?")[0],
  ])
    assert.throws(
      () =>
        run(
          wf,
          "Confirm response",
          { ...page, "@odata.nextLink": changed },
          previous,
        ),
      /pagination|continuation/,
    );
  previous["Verify sender"].request.pageToken = token;
  const bound = run(
    wf,
    "Bind conversation",
    { id: chatId, chatType: "oneOnOne" },
    previous,
  );
  assert.match(bound.readUrl, /\$orderby=createdDateTime%20desc/);
  assert.ok(bound.readUrl.endsWith(encodeURIComponent(token)));
  previous["Verify sender"].request.chatId = "another-chat";
  assert.throws(
    () =>
      run(
        wf,
        "Bind conversation",
        { id: chatId, chatType: "oneOnOne" },
        previous,
      ),
    /conversation/,
  );
});

test("CLI writes complete workflow JSON outside the repository without exporting credential secrets", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "n8n-workflows-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const command = fileURLToPath(
    new URL("./n8n-teams-workflows.mjs", import.meta.url),
  );
  execFileSync(process.execPath, [
    command,
    "--sender-id",
    senderId,
    "--recipient-id",
    recipientId,
    "--output-dir",
    dir,
  ]);
  for (const [index, action] of ["send", "read"].entries())
    assert.deepEqual(
      JSON.parse(
        readFileSync(path.join(dir, `mosaic-teams-${action}.json`), "utf8"),
      ),
      workflows(options)[index],
    );
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          command,
          "--sender-id",
          senderId,
          "--recipient-id",
          recipientId,
          "--output-dir",
          dir,
        ],
        { stdio: "pipe" },
      ),
    /EEXIST/,
  );
});
