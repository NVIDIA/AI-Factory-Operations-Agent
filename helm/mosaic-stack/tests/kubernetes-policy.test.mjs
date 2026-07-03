// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCluster,
  validateKubectlArgs,
} from "../files/openclaw-seed/extensions/kubernetes/policy.ts";

const allowed = [
  ["get", "pods", "-A", "-o", "wide"],
  ["get", "deployments", "-n", "mosaic"],
  ["describe", "pod", "openclaw-0", "-n", "mosaic"],
  ["logs", "openclaw-0", "-n", "mosaic", "--tail=100"],
  ["top", "pods", "-A"],
  ["explain", "deployment.spec"],
  ["api-resources"],
  ["api-versions"],
  ["cluster-info"],
  ["version", "--client"],
  ["auth", "can-i", "get", "pods"],
  ["auth", "can-i", "get", "secrets"],
];

for (const args of allowed) {
  test("allows kubectl " + args.join(" "), () => assert.deepEqual(validateKubectlArgs(args), args));
}

const denied = [
  ["create", "namespace", "forbidden"],
  ["apply", "-f", "manifest.yaml"],
  ["delete", "pod", "openclaw-0"],
  ["patch", "deployment", "openclaw", "-p", "{}"],
  ["exec", "openclaw-0", "--", "id"],
  ["port-forward", "pod/openclaw-0", "8080:80"],
  ["get", "secrets", "-A"],
  ["describe", "secret/api-key"],
  ["config", "view", "--raw"],
  ["get", "pods", "--server=https://example.invalid"],
  ["get", "pods", "--kubeconfig", "/tmp/admin"],
  ["get", "pods", "--token=secret"],
  ["get", "pods", "--as", "cluster-admin"],
  ["cluster-info", "dump"],
  ["auth", "reconcile", "-f", "rbac.yaml"],
];

for (const args of denied) {
  test("rejects kubectl " + args.join(" "), () => assert.throws(() => validateKubectlArgs(args)));
}

test("rejects malformed argument arrays", () => {
  assert.throws(() => validateKubectlArgs([]));
  assert.throws(() => validateKubectlArgs(["get", "pods\ncreate namespace bad"]));
  assert.throws(() => validateKubectlArgs(["get", 1]));
});

test("resolves only registered clusters", () => {
  const clusters = { local: "/clusters/local/config", remote: "/clusters/remote/config" };
  assert.deepEqual(resolveCluster(undefined, "local", clusters), {
    name: "local",
    kubeconfig: "/clusters/local/config",
  });
  assert.deepEqual(resolveCluster("remote", "local", clusters), {
    name: "remote",
    kubeconfig: "/clusters/remote/config",
  });
  assert.throws(() => resolveCluster("missing", "local", clusters));
});
