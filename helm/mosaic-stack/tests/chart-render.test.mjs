// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const chart = fileURLToPath(new URL("..", import.meta.url));

function render(...args) {
  return execFileSync("helm", ["template", "mosaic", chart, "--namespace", "mosaic-test", ...args], {
    encoding: "utf8",
  });
}

test("renders only official OpenClaw and OpenShell runtime images", () => {
  const output = render();
  for (const image of [
    "ghcr.io/openclaw/openclaw:2026.6.6",
    "ghcr.io/nvidia/openshell/gateway:0.0.75",
    "ghcr.io/nvidia/openshell/supervisor:0.0.75",
    "ghcr.io/nvidia/openshell-community/sandboxes/base@sha256:aeef1c63f00e2913ea002ccb3aaf925f338b5c5d70e63576f0d95c16a138044e",
  ]) {
    assert.ok(output.includes(image), "missing image " + image);
  }
  assert.doesNotMatch(output, /nvcr\.io\/[^\s"']*\/(?:nemoclaw|openshell)/);
  assert.doesNotMatch(output, /privileged:\s*true/);
  assert.doesNotMatch(output, /nvidia-openshell|backend["']?:\s*["']nemoclaw/);
});

test("pins every default runtime image", () => {
  const output = render();
  assert.ok(
    output.includes(
      "vllm/vllm-openai@sha256:251eba5cc7c12fed0b75da22a9240e582b1c9e39f6fbc064f86781b963bd814f",
    ),
  );
  assert.doesNotMatch(output, /image:\s*["']?\S+:latest(?:["']|\s|$)/);
});

test("renders namespace labeling with the configured kubectl image", () => {
  const output = render(
    "--show-only",
    "templates/namespace-labels.yaml",
    "--set-json",
    'namespace.labels={"example.com/managed":"true"}',
  );
  assert.match(output, /image: "registry\.k8s\.io\/kubectl:v1\.30\.0"/);
  assert.match(output, /"example\.com\/managed=true"/);
});

test("renders the OpenShell backend with mTLS under XDG_CONFIG_HOME", () => {
  const output = render();
  assert.match(output, /"backend": "openshell"/);
  assert.match(output, /name: openshell-client-tls/);
  assert.match(
    output,
    /mountPath: \/home\/node\/\.openclaw\/\.config\/openshell\/gateways\/mosaic-openshell\/mtls/,
  );
  assert.match(output, /value: "https:\/\/mosaic-openshell:8080"/);
});

test("exposes only Mosaic-owned skills to OpenClaw agents", () => {
  const output = render("--show-only", "templates/openclaw-seed-configmap.yaml");
  assert.match(
    output,
    /"skills": \[\s*"bcm",\s*"diagnostic-agent",\s*"iraop",\s*"observability",\s*"slurm"\s*\]/,
  );
  assert.doesNotMatch(output, /"allowBundled"/);
});

test("renders named external Kubernetes clusters from Secrets", () => {
  const output = render(
    "--set",
    "kubernetes.clusters[0].name=remote",
    "--set",
    "kubernetes.clusters[0].kubeconfigSecretRef.name=remote-kubeconfig",
    "--set",
    "kubernetes.clusters[0].kubeconfigSecretRef.key=config",
  );
  assert.ok(output.includes("name: kubernetes-external-0"));
  assert.ok(output.includes('secretName: "remote-kubeconfig"'));
  assert.ok(output.includes('"remote":"/var/run/mosaic-kubernetes-external/remote/config"'));
});

test("renders read-only Kubernetes RBAC including metrics without Secrets or pod execution", () => {
  const output = render("--show-only", "templates/rbac.yaml");
  assert.match(output, /apiGroups: \["metrics\.k8s\.io"\][\s\S]*resources: \["nodes", "pods"\][\s\S]*verbs: \["get", "list"\]/);
  assert.doesNotMatch(output, /resources: \[[^\]]*"secrets"/);
  assert.doesNotMatch(output, /resources: \[[^\]]*"pods\/exec"/);
  assert.doesNotMatch(output, /verbs: \[[^\]]*"(?:create|delete|patch|update)"/);
});

test("installs a checksum-pinned upstream kubectl binary", () => {
  const output = render("--show-only", "templates/openclaw.yaml");
  assert.match(output, /https:\/\/dl\.k8s\.io\/release\/v1\.34\.1\/bin\/linux\/\$architecture\/kubectl/);
  assert.match(output, /7721f265e18709862655affba5343e85e1980639395d5754473dafaadcaa69e3/);
  assert.match(output, /420e6110e3ba7ee5a3927b5af868d18df17aae36b720529ffa4e9e945aa95450/);
  assert.doesNotMatch(output, /registry\.k8s\.io\/kubectl/);
});

test("packages every Kubernetes plugin module into the OpenClaw seed", () => {
  const seed = render("--show-only", "templates/openclaw-seed-configmap.yaml");
  const deployment = render("--show-only", "templates/openclaw.yaml");
  for (const module of ["index", "policy", "runner"]) {
    assert.ok(seed.includes(`kubernetes.${module}.ts: |-`));
    assert.ok(deployment.includes(`cp /seed/kubernetes.${module}.ts /home/node/.openclaw/extensions/kubernetes/${module}.ts`));
  }
});

test("rejects an unregistered default Kubernetes cluster", () => {
  const result = spawnSync(
    "helm",
    ["template", "mosaic", chart, "--namespace", "mosaic-test", "--set", "kubernetes.defaultCluster=missing"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /defaultCluster "missing" is not registered/);
});
