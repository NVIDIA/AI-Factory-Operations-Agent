// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  formatKubectlApproval,
  isKubectlExecFallback,
  resolveCluster,
  validateKubectlAdminRequest,
  validateKubectlArgs,
  validateKubectlReadRequest,
} from "../files/openclaw-seed/extensions/kubernetes/policy.ts";
import { kubectlArgv } from "../files/openclaw-seed/extensions/kubernetes/runner.ts";

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
  ["get", "pods", "-s", "https://example.invalid"],
  ["get", "pods", "--kubeconfig", "/tmp/admin"],
  ["get", "pods", "--cluster", "admin"],
  ["get", "pods", "--token=secret"],
  ["get", "pods", "--user", "admin"],
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

test("validates the separate admin tool's stdin apply and exact-name delete", () => {
  const manifest = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "edit-test", namespace: "mosaic-edit-e2e-test" },
    data: { result: "approved" },
  };
  const apply = validateKubectlAdminRequest(["apply", "-f", "-"], manifest);
  assert.equal(apply.mutating, true);
  assert.deepEqual(apply.targets, ["ConfigMap/edit-test in namespace mosaic-edit-e2e-test"]);
  assert.equal(apply.manifestSha256?.length, 64);
  assert.deepEqual(JSON.parse(apply.manifest), manifest);
  assert.deepEqual(formatKubectlApproval(apply, "local"), {
    title: "apply ConfigMap/edit-test in namespace mosaic-edit-e2e-test",
    description: [
      "Cluster: local",
      "Command: kubectl apply -f -",
      "Standard input:",
      JSON.stringify(manifest, null, 2),
    ].join("\n"),
  });
  assert.deepEqual(validateKubectlAdminRequest(["delete", "configmap", "edit-test", "-n", "mosaic-edit-e2e-test"], undefined), {
    args: ["delete", "configmap", "edit-test", "-n", "mosaic-edit-e2e-test"],
    mutating: true,
    targets: ["configmap/edit-test in namespace mosaic-edit-e2e-test"],
  });
});

test("keeps mutation out of the read tool and blocks unsafe admin shapes", () => {
  const configMap = { apiVersion: "v1", kind: "ConfigMap", metadata: { name: "edit-test", namespace: "default" } };
  const secret = { apiVersion: "v1", kind: "Secret", metadata: { name: "forbidden", namespace: "default" } };
  assert.throws(() => validateKubectlReadRequest(["apply", "-f", "-"]), /read command/);
  assert.throws(() => validateKubectlAdminRequest(["get", "pods"], undefined), /admin command/);
  assert.throws(() => validateKubectlAdminRequest(["apply", "-f", "file.yaml"], configMap), /stdin/);
  assert.throws(() => validateKubectlAdminRequest(["apply", "-f", "-"], secret), /not editable/);
  assert.throws(() => validateKubectlAdminRequest(["apply", "-f", "-", ";", "id"], configMap), /shell syntax/);
  assert.throws(() => validateKubectlAdminRequest(["apply", "-f", "-", "--prune"], configMap), /stdin form/);
  assert.throws(() => validateKubectlAdminRequest(["apply", "-f", "-"], { ...configMap, metadata: { name: "edit-test" } }), /namespace/);
  assert.throws(() => validateKubectlAdminRequest(["delete", "secret", "api-key"], undefined), /Secret/);
  assert.throws(() => validateKubectlAdminRequest(["delete", "pods", "--all"], undefined), /bulk/);
  assert.throws(() => validateKubectlAdminRequest(["delete", "pod", "one", "two"], undefined), /exactly one/);
});

test("resolves only registered clusters", () => {
  const clusters = {
    local: "/clusters/local/config",
    remote: {
      kubeconfig: "/clusters/remote/config",
      server: "https://bcm-head.example.com:11443",
      tlsServerName: "127.0.0.1",
    },
  };
  assert.deepEqual(resolveCluster(undefined, "local", clusters), {
    name: "local",
    kubeconfig: "/clusters/local/config",
  });
  assert.deepEqual(resolveCluster("remote", "local", clusters), {
    name: "remote",
    kubeconfig: "/clusters/remote/config",
    server: "https://bcm-head.example.com:11443",
    tlsServerName: "127.0.0.1",
  });
  assert.throws(() => resolveCluster("missing", "local", clusters));
});

test("applies installer-owned API endpoint overrides outside model arguments", () => {
  assert.deepEqual(kubectlArgv(
    "/clusters/remote/config",
    ["get", "nodes"],
    "https://bcm-head.example.com:11443",
    "127.0.0.1",
  ), [
    "--kubeconfig", "/clusters/remote/config",
    "--server", "https://bcm-head.example.com:11443",
    "--tls-server-name", "127.0.0.1",
    "get", "nodes",
  ]);
});

test("accepts structured registered cluster settings in the plugin schema", () => {
  const schema = JSON.parse(readFileSync(
    new URL("../files/openclaw-seed/extensions/kubernetes/openclaw.plugin.json", import.meta.url),
    "utf8",
  ));
  const variants = schema.configSchema.properties.clusters.additionalProperties.oneOf;
  assert.deepEqual(variants.map(variant => variant.type), ["string", "object"]);
  assert.deepEqual(variants[1].required, ["kubeconfig"]);
  assert.deepEqual(Object.keys(variants[1].properties), ["kubeconfig", "server", "tlsServerName"]);
});

test("blocks kubectl fallback through exec without blocking ordinary shell commands", () => {
  for (const command of [
    "kubectl get pods",
    "which kubectl",
    "command -v kubectl",
    "/tools/kubectl version --client",
    ["sh", "-lc", "kubectl.real get pods"],
  ]) {
    assert.equal(isKubectlExecFallback("exec", { command }), true);
  }
  assert.equal(isKubectlExecFallback("exec", { command: "id && pwd" }), false);
  assert.equal(isKubectlExecFallback("run_kubectl", { command: "kubectl get pods" }), false);
});

test("registers the exec guard through OpenClaw's typed tool hook", () => {
  const source = readFileSync(
    new URL("../files/openclaw-seed/extensions/kubernetes/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /api\.on\(\s*"before_tool_call"/);
  assert.doesNotMatch(source, /api\.registerHook\(\s*"before_tool_call"/);
  assert.match(source, /text: `\$\{command\.join\(" "\)\}\\n/);
  assert.match(source, /command: \["kubectl", "<rejected>"\]/);
  assert.match(source, /blocked: true/);
  assert.match(source, /executed: false/);
  assert.match(source, /requireApproval:/);
  assert.match(source, /timeoutBehavior: "deny"/);
  assert.match(source, /formatKubectlApproval/);
  assert.match(source, /request\.manifestSha256/);
  assert.match(source, /if \(settings\.editEnabled\) api\.registerTool/);
  assert.match(source, /name: "run_kubectl_admin"/);
  assert.doesNotMatch(source, /classifyKubectlRequest/);
  assert.doesNotMatch(source, /instruction:/);
});

test("instructs the agent to stop after a Kubernetes policy denial", () => {
  const source = readFileSync(
    new URL("../files/openclaw-seed/workspace/TOOLS.md", import.meta.url),
    "utf8",
  );
  assert.match(source, /If a Kubernetes tool blocks an operation, stop immediately/);
  assert.match(source, /Do not call `exec` or retry through another tool/);
});
