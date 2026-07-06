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

test("rejects an unregistered default Kubernetes cluster", () => {
  const result = spawnSync(
    "helm",
    ["template", "mosaic", chart, "--namespace", "mosaic-test", "--set", "kubernetes.defaultCluster=missing"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /defaultCluster "missing" is not registered/);
});
