// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

const READ_ONLY_COMMANDS = new Set([
  "api-resources", "api-versions", "auth", "cluster-info", "describe", "explain", "get", "logs", "top", "version",
]);
const EDIT_COMMANDS = new Set(["apply", "delete"]);
const EDIT_KINDS = new Set(["configmap", "pod", "service", "deployment", "statefulset", "daemonset", "job", "cronjob"]);
const FORBIDDEN_FLAGS = new Set([
  "--as", "--as-group", "--as-uid", "--certificate-authority", "--client-certificate", "--client-key", "--cluster",
  "--context", "--insecure-skip-tls-verify", "--kubeconfig", "--password", "--raw", "--server", "--token", "--user",
  "--username",
]);
const FORBIDDEN_SHORT_FLAGS = new Set(["-s"]);
const SECRET_RESOURCE = /(^|[./])secrets?($|[./])/i;
const KUBECTL_COMMAND = /(^|[^a-z0-9_-])kubectl(?:\.real)?(?=$|[^a-z0-9_-])/i;
const SHELL_SYNTAX = /[;&|`$<>]/;
const MAX_MANIFEST_BYTES = 1_048_576;
const RESOURCE_NAME = /^[a-z0-9]([-.a-z0-9]*[a-z0-9])?$/;
const NAMESPACE_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export type KubectlRequest = {
  args: string[];
  mutating: boolean;
  manifest?: string;
  targets: string[];
  manifestSha256?: string;
};

function quoteCommandArg(value: string) {
  return /^[a-zA-Z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function formatKubectlApproval(request: KubectlRequest, cluster: string) {
  const description = [
    `Cluster: ${cluster}`,
    `Command: ${["kubectl", ...request.args].map(quoteCommandArg).join(" ")}`,
  ];
  if (request.manifest) description.push("Standard input:", JSON.stringify(JSON.parse(request.manifest), null, 2));
  return {
    title: `${request.args[0]} ${request.targets[0]}`.slice(0, 80),
    description: description.join("\n"),
  };
}

function flagName(arg: string) {
  return arg.startsWith("--") ? arg.split("=", 1)[0] : arg;
}

function referencesSecret(args: string[]) {
  return args.some((arg) => arg.split(",").filter(Boolean).some((part) => SECRET_RESOURCE.test(part)));
}

function normalizeKind(value: string) {
  return value.trim().toLowerCase().split(".", 1)[0].replace(/s$/, "");
}

function assertEditableKind(kind: string) {
  const normalized = normalizeKind(kind);
  if (!EDIT_KINDS.has(normalized)) throw new Error("Kubernetes resource kind is not editable: " + kind);
  return normalized;
}

function parseManifest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("manifest must be one structured Kubernetes object");
  }
  const record = value as Record<string, unknown>;
  const metadata = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : {};
  const kind = typeof record.kind === "string" ? record.kind.trim() : "";
  const name = typeof metadata.name === "string" ? metadata.name.trim() : "";
  const namespace = typeof metadata.namespace === "string" ? metadata.namespace.trim() : "";
  if (!kind || !name || !namespace) throw new Error("manifest requires kind, metadata.name, and metadata.namespace");
  assertEditableKind(kind);
  if (!RESOURCE_NAME.test(name) || name.length > 253) throw new Error("manifest metadata.name is invalid");
  if (!NAMESPACE_NAME.test(namespace) || namespace.length > 63) throw new Error("manifest metadata.namespace is invalid");
  const manifest = JSON.stringify(record);
  if (Buffer.byteLength(manifest) > MAX_MANIFEST_BYTES) throw new Error("manifest cannot exceed 1048576 bytes");
  return {
    manifest,
    target: `${kind}/${name} in namespace ${namespace}`,
    sha256: createHash("sha256").update(manifest).digest("hex"),
  };
}

function validateArgs(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("args must be a non-empty string array");
  if (value.length > 64) throw new Error("args cannot contain more than 64 entries");
  const args = value.map((arg) => {
    if (typeof arg !== "string" || !arg || arg.length > 4096 || /[\0\r\n]/.test(arg)) {
      throw new Error("each kubectl argument must be a non-empty single-line string no longer than 4096 characters");
    }
    if (SHELL_SYNTAX.test(arg)) throw new Error("shell syntax is not allowed in kubectl arguments");
    return arg;
  });
  for (const arg of args) {
    const flag = flagName(arg);
    if (FORBIDDEN_FLAGS.has(flag) || FORBIDDEN_SHORT_FLAGS.has(flag)) throw new Error("kubectl option is not allowed: " + flag);
  }
  const isPermissionCheck = args[0].toLowerCase() === "auth" && args[1]?.toLowerCase() === "can-i";
  if (!isPermissionCheck && referencesSecret(args.slice(1))) {
    throw new Error("Kubernetes Secret resources are not accessible");
  }
  return args;
}

function isExactStdinApply(args: string[]) {
  return (args.length === 3 && ["-f", "--filename"].includes(args[1]) && args[2] === "-") ||
    (args.length === 2 && args[1] === "--filename=-");
}

function deleteTarget(args: string[]) {
  const positional: string[] = [];
  let namespace = "";
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-n" || arg === "--namespace") {
      if (namespace || !args[index + 1]) throw new Error("kubectl delete namespace is invalid");
      namespace = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--namespace=")) {
      if (namespace) throw new Error("kubectl delete namespace is invalid");
      namespace = arg.slice("--namespace=".length);
    } else if (arg.startsWith("-")) {
      if (["--all", "-l"].includes(arg) || arg.startsWith("--selector") || arg.startsWith("-l=")) {
        throw new Error("bulk and selector-based delete are not allowed");
      }
      throw new Error("kubectl delete option is not allowed: " + arg);
    } else {
      positional.push(arg);
    }
  }
  const resource = positional[0] || "";
  const embeddedName = resource.includes("/") ? resource.slice(resource.indexOf("/") + 1) : "";
  const name = embeddedName || positional[1] || "";
  const kind = resource.split("/", 1)[0];
  const expectedLength = embeddedName ? 1 : 2;
  if (!kind || !name || positional.length !== expectedLength) {
    throw new Error("kubectl delete requires exactly one resource kind and name");
  }
  assertEditableKind(kind);
  if (!RESOURCE_NAME.test(name) || name.length > 253) throw new Error("kubectl delete resource name is invalid");
  if (namespace && (!NAMESPACE_NAME.test(namespace) || namespace.length > 63)) {
    throw new Error("kubectl delete namespace is invalid");
  }
  return `${kind}/${name}${namespace ? ` in namespace ${namespace}` : ""}`;
}

export function isKubectlExecFallback(toolName: string, params: Record<string, unknown>) {
  if (toolName !== "exec") return false;
  const command = params.command;
  if (typeof command === "string") return KUBECTL_COMMAND.test(command);
  return Array.isArray(command) && command.some((arg) => typeof arg === "string" && KUBECTL_COMMAND.test(arg));
}

export function classifyKubectlRequest(value: unknown, manifest: unknown, editEnabled: boolean): KubectlRequest {
  const args = validateArgs(value);
  const command = args[0].toLowerCase();
  if (READ_ONLY_COMMANDS.has(command)) {
    if (manifest !== undefined) throw new Error("manifest is accepted only for kubectl apply");
    if (command === "auth" && args[1]?.toLowerCase() !== "can-i") throw new Error("only kubectl auth can-i is allowed");
    if (command === "cluster-info" && args[1]?.toLowerCase() === "dump") throw new Error("kubectl cluster-info dump is not allowed");
    return { args, mutating: false, targets: [] };
  }
  if (!EDIT_COMMANDS.has(command) || !editEnabled) throw new Error("kubectl command is not enabled: " + args[0]);
  if (command === "apply") {
    if (!isExactStdinApply(args)) throw new Error("kubectl apply must use only the stdin form -f -");
    const parsed = parseManifest(manifest);
    return {
      args,
      mutating: true,
      manifest: parsed.manifest,
      targets: [parsed.target],
      manifestSha256: parsed.sha256,
    };
  }
  if (manifest !== undefined) throw new Error("manifest is accepted only for kubectl apply");
  return { args, mutating: true, targets: [deleteTarget(args)] };
}

export function validateKubectlArgs(value: unknown): string[] {
  return classifyKubectlRequest(value, undefined, false).args;
}

export type KubernetesClusterConfig = {
  kubeconfig: string;
  server?: string;
  tlsServerName?: string;
};

export function resolveCluster(
  requested: unknown,
  defaultCluster: string,
  clusters: Record<string, string | KubernetesClusterConfig>,
) {
  if (requested !== undefined && (typeof requested !== "string" || !requested.trim())) {
    throw new Error("cluster must be a non-empty string");
  }
  const name = typeof requested === "string" ? requested.trim() : defaultCluster;
  const configured = clusters[name];
  if (!configured) throw new Error("unknown Kubernetes cluster: " + name);
  return {
    name,
    ...(typeof configured === "string" ? { kubeconfig: configured } : configured),
  };
}
