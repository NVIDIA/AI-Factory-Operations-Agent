// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runMutationOnce } from "../files/openclaw-seed/extensions/mutation-ledger.ts";

const directory = mkdtempSync(path.join(tmpdir(), "mosaic-mutation-ledger-"));
const ledgerPath = path.join(directory, "ledger.json");
test.after(() => rmSync(directory, { recursive: true, force: true }));

test("suppresses a completed replay without persisting arguments", async () => {
  let calls = 0;
  const input = { toolCallId: "completed", toolName: "run_remote_ssh", target: "node", args: ["secret-argument"], ledgerPath };
  const first = await runMutationOnce(input, async () => ++calls);
  const replay = await runMutationOnce(input, async () => ++calls);
  assert.equal(first.replayed, false);
  assert.deepEqual(replay, { replayed: true, state: "completed" });
  assert.equal(calls, 1);
  assert.doesNotMatch(readFileSync(ledgerPath, "utf8"), /secret-argument/);
});

test("suppresses a concurrent replay while the first call is running", async () => {
  let release;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const input = { toolCallId: "concurrent", toolName: "run_kubectl", target: "local", args: ["apply"], ledgerPath };
  const first = runMutationOnce(input, async () => { started(); await wait; return true; });
  await ready;
  assert.deepEqual(await runMutationOnce(input, async () => false), { replayed: true, state: "running" });
  release();
  await first;
});

test("records failure and rejects reuse with different arguments", async () => {
  const input = { toolCallId: "failed", toolName: "bcm_execute_cmsh", target: "bcm", args: "category; add test", ledgerPath };
  await assert.rejects(runMutationOnce(input, async () => { throw new Error("failed"); }), /failed/);
  assert.deepEqual(await runMutationOnce(input, async () => true), { replayed: true, state: "failed" });
  await assert.rejects(runMutationOnce({ ...input, args: "category; remove test" }, async () => true), /different mutation/);
});
