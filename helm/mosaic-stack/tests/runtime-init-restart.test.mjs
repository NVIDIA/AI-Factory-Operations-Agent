// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const chart = fileURLToPath(new URL("..", import.meta.url));

function render(...args) {
  return execFileSync("helm", ["template", "mosaic", chart, "--namespace", "mosaic-test", ...args], {
    encoding: "utf8",
  });
}

// Each init container installs a tool file as mode 0555 (read-only). The tools
// directory is an emptyDir that survives container restarts within a Pod, so on
// a node/kubelet restart the init container reruns against the existing 0555
// file. Writing it again (curl -o, printf >, tar + mv) then fails with "Text
// file busy"/permission denied and the Pod enters Init:CrashLoopBackOff. The
// installer must remove the stale file before rewriting it so re-initialization
// is idempotent.
function assertRemovesBeforeWriting(script, removal, write, label) {
  const removedAt = script.indexOf(removal);
  const writtenAt = script.indexOf(write);
  assert.notEqual(removedAt, -1, `${label}: expected "${removal}" in the init script`);
  assert.notEqual(writtenAt, -1, `${label}: expected "${write}" in the init script`);
  assert.ok(removedAt < writtenAt, `${label}: "${removal}" must come before "${write}"`);
}

test("openclaw tool init removes read-only files before rewriting them", () => {
  const openclaw = render("--show-only", "templates/openclaw.yaml");
  assertRemovesBeforeWriting(
    openclaw,
    "rm -f /tools/kubectl",
    "curl -fsSL --retry 5 --retry-all-errors -o /tools/kubectl",
    "kubectl",
  );
  assertRemovesBeforeWriting(
    openclaw,
    'rm -f "/tools/$command"',
    '> "/tools/$command"',
    "ssh wrappers",
  );
  assertRemovesBeforeWriting(
    openclaw,
    "rm -f /tools/openshell /tools/openshell.real",
    'tar -xzf "$cli" -C /tools',
    "openshell cli",
  );
});

test("terminal kubectl init removes the read-only binary before rewriting it", () => {
  const terminal = render(
    "--set", "modules.terminal.enabled=true",
    "--set", "modules.kubernetes.enabled=true",
    "--show-only", "templates/mosaic-terminal.yaml",
  );
  assertRemovesBeforeWriting(
    terminal,
    "rm -f /tools/kubectl",
    "curl -fsSL --retry 5 --retry-all-errors -o /tools/kubectl",
    "terminal kubectl",
  );
});
