// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const chart = fileURLToPath(new URL("..", import.meta.url));
const patch = fileURLToPath(new URL("../files/openclaw-seed/weixin-owner-patch.mjs", import.meta.url));
const enabled = ["--set", "openclaw.weixin.enabled=true"];

function render(...args) {
  return execFileSync("helm", ["template", "mosaic", chart, ...args], { encoding: "utf8" });
}

function config(...args) {
  const output = render(...args, "--show-only", "templates/openclaw-seed-configmap.yaml");
  const lines = output.split("\n");
  const start = lines.findIndex(line => line.startsWith("  openclaw.json: |"));
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith("    ")) break;
    body.push(line.slice(4));
  }
  return JSON.parse(body.join("\n"));
}

test("personal WeChat is opt-in, uses persistent state and adds no inbound listener", () => {
  assert.equal(config().channels?.["openclaw-weixin"], undefined);
  assert.ok(!config().plugins.allow.includes("openclaw-weixin"));
  assert.doesNotMatch(render(), /init-weixin-plugin|weixin-owner-patch/);
  const output = render(...enabled);
  const c = config(...enabled);
  assert.ok(c.plugins.allow.includes("openclaw-weixin"));
  assert.deepEqual(c.plugins.entries["openclaw-weixin"], { enabled: true });
  assert.equal(c.channels["openclaw-weixin"].enabled, true);
  assert.equal(c.channels["openclaw-weixin"].quoteCache.enabled, false);
  assert.equal(c.session.dmScope, "per-account-channel-peer");
  assert.match(output, /@tencent-weixin\/openclaw-weixin@2\.4\.10/);
  assert.match(output, /node \/seed\/weixin-owner-patch\.mjs/);
  assert.match(output, /mountPath: \/home\/node\/\.openclaw/);
  assert.doesNotMatch(output, /kind: Ingress|WEIXIN_TOKEN/);
});

test("personal WeChat preserves Slack and isolates accounts across channels", () => {
  const slack = [
    "--set", "openclaw.slack.enabled=true",
    "--set", "openclaw.slack.existingSecret=mosaic-slack",
    "--set", "openclaw.slack.allowedUserIds[0]=U11111111",
  ];
  assert.deepEqual(config(...enabled, ...slack).channels.slack, config(...slack).channels.slack);
  assert.equal(config(...enabled, ...slack).session.dmScope, "per-account-channel-peer");
});

test("personal WeChat rejects missing runtime and unqualified plugin versions", () => {
  for (const setting of ["modules.execution.enabled=false", "openclaw.enabled=false", "openclaw.weixin.pluginVersion=2.4.8"]) {
    const result = spawnSync("helm", ["template", "mosaic", chart, ...enabled, "--set", setting], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /openclaw\.weixin/);
  }
});

test("the owner gate precedes commands/media/dispatch, survives reapplication and denies ownerless state", async () => {
  const root = mkdtempSync(join(tmpdir(), "mosaic-weixin-owner-"));
  try {
    mkdirSync(join(root, "auth"));
    mkdirSync(join(root, "messaging"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "auth/accounts.js"), `export function loadWeixinAccount(id) {
      return id === "paired" ? { userId: "owner@im.wechat" } : {};
    }`);
    const processor = join(root, "messaging/process-message.js");
    writeFileSync(processor, `import { loadWeixinAccount } from "../auth/accounts.js";
const logger = { warn() {} };
export const effects = [];
export async function processOneMessage(full, deps) {
    const receivedAt = Date.now();
    effects.push("slash-command", "media-download", "agent-dispatch");
}
`);
    execFileSync(process.execPath, [patch, processor]);
    const once = readFileSync(processor, "utf8");
    execFileSync(process.execPath, [patch, processor]);
    assert.equal(readFileSync(processor, "utf8"), once);
    const { processOneMessage, effects } = await import(pathToFileURL(processor).href);
    await processOneMessage({ from_user_id: "stranger@im.wechat" }, { accountId: "paired" });
    await processOneMessage({ from_user_id: "owner@im.wechat" }, { accountId: "ownerless" });
    assert.deepEqual(effects, []);
    await processOneMessage({ from_user_id: "owner@im.wechat" }, { accountId: "paired" });
    assert.deepEqual(effects, ["slash-command", "media-download", "agent-dispatch"]);
    writeFileSync(processor, "export async function processOneMessage() {}\n");
    const changed = spawnSync(process.execPath, [patch, processor], { encoding: "utf8" });
    assert.notEqual(changed.status, 0);
    assert.match(changed.stderr, /patch target changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
