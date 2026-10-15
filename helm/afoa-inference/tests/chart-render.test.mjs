// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const chart = fileURLToPath(new URL("..", import.meta.url));
const render = (...args) => execFileSync("helm", ["template", "test-inference", chart, ...args], {encoding: "utf8"});

test("standalone inference renders only a GPU workload and its Service", () => {
  const output = render();
  assert.deepEqual([...output.matchAll(/^kind: (.+)$/gm)].map(match => match[1]).sort(), ["Service", "StatefulSet"]);
  assert.match(output, /mountPath: \/models/);
  assert.match(output, /volumeClaimTemplates:/);
  assert.equal([...output.matchAll(/nvidia\.com\/gpu: "1"/g)].length, 2);
  assert.match(output, /name: VLLM_API_KEY\s+valueFrom:\s+secretKeyRef:/);
  assert.doesNotMatch(output, /kind: Secret/);
});

test("site hardware, storage, and credentials can be configured independently", () => {
  for (const gpuCount of [2, 4]) {
    const output = render(
      "--set", `gpuCount=${gpuCount},tensorParallelSize=${gpuCount}`,
      "--set", "nodeSelector.hardware=compatible,modelCache.storageClassName=fast-storage",
      "--set", "auth.existingSecret=client-key,auth.apiKeySecretKey=token",
      "--set", "modelToken.existingSecret=download-key",
    );
    assert.equal([...output.matchAll(new RegExp(`nvidia\\.com\\/gpu: "${gpuCount}"`, "g"))].length, 2);
    assert.match(output, new RegExp(`--tensor-parallel-size=${gpuCount}`));
    assert.match(output, /hardware: compatible/);
    assert.match(output, /storageClassName: "fast-storage"/);
    assert.match(output, /name: "client-key"\s+key: "token"/);
    assert.match(output, /name: HF_TOKEN\s+valueFrom:\s+secretKeyRef:\s+name: "download-key"/);
  }
});

test("cross-cluster ingress routes only the API and references site TLS", () => {
  const output = render("--show-only", "templates/ingress.yaml", "--set", "ingress.enabled=true,ingress.host=inference.example.com,ingress.tlsSecretName=site-tls,ingress.className=internal");
  assert.match(output, /ingressClassName: "internal"/);
  assert.match(output, /secretName: "site-tls"/);
  assert.match(output, /host: "inference.example.com"/);
  assert.deepEqual([...output.matchAll(/path: (.+)/g)].map(match => match[1]), ["/v1"]);
  assert.match(output, /name: test-inference/);
});

test("missing inference authentication or ingress TLS fails before installation", () => {
  for (const settings of [
    "auth.existingSecret=",
    "auth.apiKeySecretKey=",
    "ingress.enabled=true,ingress.host=inference.example.com",
    "ingress.enabled=true,ingress.tlsSecretName=site-tls",
  ]) {
    const result = spawnSync("helm", ["template", "test-inference", chart, "--set", settings], {encoding: "utf8"});
    assert.notEqual(result.status, 0, settings);
    assert.match(result.stderr, /is required/);
  }
});
