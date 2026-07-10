// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runKubectl } from "../files/openclaw-seed/extensions/kubernetes/runner.ts";

const directory = mkdtempSync(path.join(tmpdir(), "mosaic-kubectl-runner-"));
const command = path.join(directory, "kubectl");
const kubeconfig = path.join(directory, "sensitive-config");

writeFileSync(
  command,
  `#!/bin/sh
config="$2"
case "$3" in
  result) printf 'stdout %s' "$config"; printf 'stderr %s' "$config" >&2; exit 7 ;;
  large) head -c 64 /dev/zero ;;
  sleep) sleep 2 ;;
  stdin) cat ;;
esac
`,
);
chmodSync(command, 0o755);

test.after(() => rmSync(directory, { recursive: true, force: true }));

test("returns exit status and redacts the kubeconfig path", async () => {
  assert.deepEqual(await runKubectl(command, ["result"], kubeconfig, 10_000, 1_024), {
    code: 7,
    stdout: "stdout <kubeconfig>",
    stderr: "stderr <kubeconfig>",
  });
});

test("enforces the combined output limit", async () => {
  await assert.rejects(runKubectl(command, ["large"], kubeconfig, 1_000, 16), /exceeded 16 bytes/);
});

test("terminates commands after the configured timeout", async () => {
  await assert.rejects(runKubectl(command, ["sleep"], kubeconfig, 20, 1_024), /timed out after 20 ms/);
});

test("reports command launch failures", async () => {
  await assert.rejects(runKubectl(path.join(directory, "missing"), ["result"], kubeconfig, 1_000, 1_024), /ENOENT/);
});

test("passes an apply manifest only over stdin", async () => {
  assert.deepEqual(await runKubectl(command, ["stdin"], kubeconfig, 1_000, 1_024, "manifest-data"), {
    code: 0,
    stdout: "manifest-data",
    stderr: "",
  });
});
