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

test("validates arbitrary exact admin argv and optional stdin", () => {
  const stdin = JSON.stringify({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "edit-test", namespace: "mosaic-edit-e2e-test" },
  });
  const apply = validateKubectlAdminRequest(["apply", "-f", "-"], stdin);
  assert.equal(apply.mutating, true);
  assert.deepEqual(apply.targets, ["apply"]);
  assert.equal(apply.stdinSha256?.length, 64);
  assert.equal(apply.stdin, stdin);
  assert.deepEqual(formatKubectlApproval(apply, "local"), {
    title: "kubectl apply",
    description: [
      "Cluster: local",
      "Command: kubectl apply -f -",
      "Standard input:",
      stdin,
    ].join("\n"),
  });
  const exec = validateKubectlAdminRequest([
    "exec", "diagnostic-pod", "-n", "mosaic-edit-e2e-test", "--", "sh", "-c", "touch /tmp/proof && cat /tmp/proof",
  ], undefined);
  assert.deepEqual(exec.args.slice(0, 2), ["exec", "diagnostic-pod"]);
  assert.equal(exec.stdin, undefined);
  assert.equal(formatKubectlApproval(exec, "local").title, "kubectl exec");
  assert.match(formatKubectlApproval(exec, "local").description, /touch \/tmp\/proof && cat \/tmp\/proof/);
  assert.deepEqual(validateKubectlAdminRequest([
    "create", "configmap", "edit-test", "-n", "mosaic-edit-e2e-test", "--from-literal=demo=approved",
  ], undefined).targets, ["create"]);
});

test("keeps mutation out of the read tool and protects admin credentials", () => {
  assert.throws(() => validateKubectlReadRequest(["apply", "-f", "-"]), /read command/);
  assert.deepEqual(validateKubectlAdminRequest(["get", "secrets", "-A"], undefined).args, ["get", "secrets", "-A"]);
  assert.deepEqual(validateKubectlAdminRequest(["delete", "pods", "--all"], undefined).args, ["delete", "pods", "--all"]);
  assert.throws(() => validateKubectlAdminRequest(["get", "pods", "--kubeconfig=/tmp/admin"], undefined), /not allowed/);
  assert.throws(() => validateKubectlAdminRequest(["get", "pods", "-s=https:\/\/alternate.invalid"], undefined), /not allowed/);
  assert.throws(() => validateKubectlAdminRequest(["get", "pods"], { unexpected: true }), /stdin must be a string/);
  assert.throws(() => validateKubectlAdminRequest(["get", "pods"], "x".repeat(1_048_577)), /cannot exceed/);
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

test("registers the exec guard through OpenClaw's trusted tool policy", () => {
  const source = readFileSync(
    new URL("../files/openclaw-seed/extensions/kubernetes/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /api\.registerTrustedToolPolicy\(/);
  assert.match(source, /id: "kubernetes-access"/);
  assert.match(source, /text: `\$\{command\.join\(" "\)\}\\n/);
  assert.match(source, /command: \["kubectl", "<rejected>"\]/);
  assert.match(source, /blocked: true/);
  assert.match(source, /executed: false/);
  assert.match(source, /requireApproval:/);
  assert.match(source, /timeoutBehavior: "deny"/);
  assert.match(source, /formatKubectlApproval/);
  assert.match(source, /request\.stdinSha256/);
  assert.match(source, /if \(settings\.editEnabled\) api\.registerTool/);
  assert.match(source, /name: "run_kubectl_admin"/);
  assert.match(source, /validateKubectlAdminRequest\(event\.params\.args, event\.params\.stdin\)/);
  assert.match(source, /Run exact kubectl arguments/);
  assert.match(source, /maxLength: 1048576/);
  assert.doesNotMatch(source, /Apply must be exactly/);
  assert.doesNotMatch(source, /classifyKubectlRequest/);
  assert.doesNotMatch(source, /instruction:/);
});

test("instructs the agent to report a Kubernetes policy denial", () => {
  const source = readFileSync(
    new URL("../files/openclaw-seed/workspace/TOOLS.md", import.meta.url),
    "utf8",
  );
  assert.match(source, /give a brief plain-text final response that the action was not performed/);
  assert.match(source, /Do not call `exec` or retry through another tool/);
});

test("instructs the agent to finish after a successful mutation", () => {
  const source = readFileSync(
    new URL("../files/openclaw-seed/workspace/AGENTS.md", import.meta.url),
    "utf8",
  );
  assert.match(source, /immediately provide a brief final answer and stop/);
  assert.match(source, /Do not run a separate verification read/);
});
