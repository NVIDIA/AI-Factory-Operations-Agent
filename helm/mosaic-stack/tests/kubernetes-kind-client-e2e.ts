// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { resolveCluster, validateKubectlArgs } from "/test/policy.ts";
import { runKubectl } from "/test/runner.ts";

const clusters = {
  external: "/configs/external/config",
  local: "/configs/local/config",
};

async function kubectl(cluster: keyof typeof clusters, args: string[]) {
  const validated = validateKubectlArgs(args);
  const resolved = resolveCluster(cluster, "local", clusters);
  return runKubectl("/tools/kubectl", validated, resolved.kubeconfig, 30_000, 1_048_576);
}

async function succeeds(cluster: keyof typeof clusters, args: string[], expected: RegExp) {
  const result = await kubectl(cluster, args);
  assert.equal(result.code, 0, `${cluster}: kubectl ${args.join(" ")}\n${result.stderr}`);
  assert.match(result.stdout, expected);
  assert.doesNotMatch(result.stdout + result.stderr, /\/configs\/(?:local|external)\/config/);
}

async function cannot(cluster: keyof typeof clusters, verb: string, resource: string) {
  const result = await kubectl(cluster, ["auth", "can-i", verb, resource]);
  assert.equal(result.code, 1, `${cluster}: auth can-i ${verb} ${resource}\n${result.stderr}`);
  assert.match(result.stdout, /^no\s*$/m);
}

for (const [cluster, marker] of [
  ["local", "local-cluster-marker"],
  ["external", "external-cluster-marker"],
] as const) {
  await succeeds(cluster, ["get", "configmap", marker, "-n", "kube-system", "-o", "name"], new RegExp(marker));
  await succeeds(cluster, ["get", "pods", "-A"], /kube-system/);
  await succeeds(cluster, ["get", "deployments", "-A"], /coredns/);
  await succeeds(cluster, ["describe", "pod", "e2e-log-source", "-n", "default"], /e2e-log-source/);
  await succeeds(cluster, ["logs", "e2e-log-source", "-n", "default"], /kubernetes-plugin-e2e/);
  await succeeds(cluster, ["api-resources"], /pods/);
  await succeeds(cluster, ["auth", "can-i", "get", "pods"], /^yes\s*$/m);
  await cannot(cluster, "get", "secrets");
  await cannot(cluster, "create", "namespaces");
  await cannot(cluster, "patch", "deployments.apps");
  await cannot(cluster, "delete", "pods");
  await cannot(cluster, "create", "pods/exec");
}

for (const args of [
  ["get", "secrets", "-A"],
  ["create", "namespace", "forbidden-test"],
  ["apply", "-f", "manifest.yaml"],
  ["patch", "deployment", "sample", "-p", "{}"],
  ["delete", "pod", "sample"],
  ["exec", "sample", "--", "id"],
  ["port-forward", "sample", "8080:80"],
  ["config", "view", "--raw"],
  ["get", "pods", "--server=https://alternate.invalid"],
  ["get", "pods", "--kubeconfig=/tmp/alternate"],
  ["get", "pods", "--as=system:admin"],
]) {
  assert.throws(() => validateKubectlArgs(args));
}

assert.throws(() => resolveCluster("missing", "local", clusters), /unknown Kubernetes cluster/);
console.log("kubernetes-kind-client-e2e-passed");
