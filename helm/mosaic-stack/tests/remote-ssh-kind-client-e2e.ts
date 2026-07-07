// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import plugin from "./index.ts";

const marker = "/tmp/mosaic-remote-ssh-kind-marker";
const baseConfig = {
  command: "/tools/ssh",
  keyPath: "/credentials/id",
  knownHostsPath: "/credentials/known_hosts",
  hosts: [{ alias: "kind-target", address: "ssh-target", user: "tester", port: 22 }],
  hitl: true,
  approvalTimeoutMs: 5_000,
  timeoutMs: 5_000,
  maxOutputBytes: 4_096,
};

function register(pluginConfig = baseConfig) {
  let hook: (event: Record<string, unknown>) => unknown = () => undefined;
  let tool: { execute: (id: string, params: Record<string, unknown>) => Promise<Record<string, unknown>> } | undefined;
  plugin.register({
    pluginConfig,
    on(name: string, handler: typeof hook) {
      if (name === "before_tool_call") hook = handler;
    },
    registerTool(value: typeof tool) {
      tool = value;
    },
  } as never);
  assert.ok(tool);
  return { hook, tool };
}

async function run(
  tool: NonNullable<ReturnType<typeof register>["tool"]>,
  argv: string[],
  extra: Record<string, unknown> = {},
) {
  const response = await tool.execute("kind-e2e", { host: "kind-target", argv, ...extra });
  return response.details as Record<string, unknown>;
}

const { hook, tool } = register();
const request = { host: "kind-target", argv: ["/bin/busybox", "touch", marker] };
const approval = hook({ toolName: "run_remote_ssh", params: request }) as Record<string, unknown>;
const approvalDetails = approval.requireApproval as Record<string, unknown>;
assert.equal(approvalDetails.title, "Remote command on kind-target");
assert.match(String(approvalDetails.description), /touch.*mosaic-remote-ssh-kind-marker/);
assert.doesNotMatch(JSON.stringify(approvalDetails), /credentials|privateKey|known_hosts/);

assert.equal((await run(tool, ["/bin/busybox", "test", "!", "-e", marker])).exitCode, 0);
// Denial means the broker never invokes the registered tool.
assert.equal((await run(tool, ["/bin/busybox", "test", "!", "-e", marker])).exitCode, 0);

assert.equal((await tool.execute("approved", request)).details.exitCode, 0);
assert.equal((await run(tool, ["/bin/busybox", "test", "-e", marker])).exitCode, 0);
assert.equal((await run(tool, ["/bin/busybox", "rm", "-f", marker])).exitCode, 0);
assert.equal((await run(tool, ["/bin/busybox", "test", "!", "-e", marker])).exitCode, 0);

const literal = await run(tool, ["/bin/busybox", "printf", "%s", "a b;$(id)"]);
assert.equal(literal.stdout, "a b;$(id)");

const redacted = await run(tool, ["/bin/busybox", "printf", "%s", "/credentials/id"]);
assert.equal(redacted.stdout, "<ssh-private-key>");

for (const params of [
  { host: "missing", argv: ["/bin/true"] },
  { host: "kind-target", argv: ["/bin/true"], identityFile: "/tmp/override" },
  { host: "kind-target", argv: ["ssh", "elsewhere"] },
]) {
  const denied = hook({ toolName: "run_remote_ssh", params }) as Record<string, unknown>;
  assert.equal(denied.block, true);
}

const timeoutPlugin = register({ ...baseConfig, timeoutMs: 500 });
const timeout = await run(timeoutPlugin.tool, ["/bin/busybox", "sleep", "2"]);
assert.equal(timeout.blocked, true);
assert.match(String(timeout.reason), /timed out/);

const boundedPlugin = register({ ...baseConfig, maxOutputBytes: 32 });
const bounded = await run(boundedPlugin.tool, ["/bin/busybox", "head", "-c", "1024", "/dev/zero"]);
assert.equal(bounded.blocked, true);
assert.match(String(bounded.reason), /output exceeded 32 bytes/);

const fullAuto = register({ ...baseConfig, hitl: false });
assert.equal(fullAuto.hook({ toolName: "run_remote_ssh", params: request }), undefined);

console.log("remote-ssh-kind-e2e-passed");
