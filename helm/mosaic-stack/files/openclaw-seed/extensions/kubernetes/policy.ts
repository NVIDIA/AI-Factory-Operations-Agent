// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

const READ_ONLY_COMMANDS = new Set([
  "api-resources", "api-versions", "auth", "cluster-info", "describe", "explain", "get", "logs", "top", "version",
]);
const FORBIDDEN_FLAGS = new Set([
  "--as", "--as-group", "--as-uid", "--certificate-authority", "--client-certificate", "--client-key", "--cluster",
  "--context", "--insecure-skip-tls-verify", "--kubeconfig", "--password", "--raw", "--server", "--token", "--user",
  "--username",
]);
const FORBIDDEN_SHORT_FLAGS = new Set(["-s"]);
const SECRET_RESOURCE = /(^|[./])secrets?($|[./])/i;
const KUBECTL_COMMAND = /(^|[^a-z0-9_-])kubectl(?:\.real)?(?=$|[^a-z0-9_-])/i;
const SHELL_SYNTAX = /[;&|`$<>]/;
const MAX_STDIN_BYTES = 1_048_576;

export type KubectlRequest = {
  args: string[];
  mutating: boolean;
  stdin?: string;
  targets: string[];
  stdinSha256?: string;
};

function quoteCommandArg(value: string) {
  return /^[a-zA-Z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function formatKubectlApproval(request: KubectlRequest, cluster: string) {
  const description = [
    `Cluster: ${cluster}`,
    `Command: ${["kubectl", ...request.args].map(quoteCommandArg).join(" ")}`,
  ];
  if (request.stdin !== undefined) description.push("Standard input:", request.stdin);
  return {
    title: `kubectl ${request.args[0]}`.slice(0, 80),
    description: description.join("\n"),
  };
}

function flagName(arg: string) {
  if (arg.startsWith("--")) return arg.split("=", 1)[0];
  return arg.startsWith("-s=") ? "-s" : arg;
}

function referencesSecret(args: string[]) {
  return args.some((arg) => arg.split(",").filter(Boolean).some((part) => SECRET_RESOURCE.test(part)));
}

function validateArgs(value: unknown, admin = false) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("args must be a non-empty string array");
  if (value.length > 64) throw new Error("args cannot contain more than 64 entries");
  const args = value.map((arg) => {
    if (typeof arg !== "string" || !arg || arg.length > 4096 || /[\0\r\n]/.test(arg)) {
      throw new Error("each kubectl argument must be a non-empty single-line string no longer than 4096 characters");
    }
    if (!admin && SHELL_SYNTAX.test(arg)) throw new Error("shell syntax is not allowed in kubectl read arguments");
    return arg;
  });
  for (const arg of args) {
    const flag = flagName(arg);
    if (FORBIDDEN_FLAGS.has(flag) || FORBIDDEN_SHORT_FLAGS.has(flag)) throw new Error("kubectl option is not allowed: " + flag);
  }
  const isPermissionCheck = args[0].toLowerCase() === "auth" && args[1]?.toLowerCase() === "can-i";
  if (!admin && !isPermissionCheck && referencesSecret(args.slice(1))) {
    throw new Error("Kubernetes Secret resources are not accessible");
  }
  return args;
}

function validateStdin(value: unknown) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("stdin must be a string");
  if (Buffer.byteLength(value) > MAX_STDIN_BYTES) throw new Error("stdin cannot exceed 1048576 bytes");
  return value;
}

export function isKubectlExecFallback(toolName: string, params: Record<string, unknown>) {
  if (toolName !== "exec") return false;
  const command = params.command;
  if (typeof command === "string") return KUBECTL_COMMAND.test(command);
  return Array.isArray(command) && command.some((arg) => typeof arg === "string" && KUBECTL_COMMAND.test(arg));
}

export function validateKubectlReadRequest(value: unknown): KubectlRequest {
  const args = validateArgs(value);
  const command = args[0].toLowerCase();
  if (!READ_ONLY_COMMANDS.has(command)) throw new Error("kubectl read command is not enabled: " + args[0]);
  if (command === "auth" && args[1]?.toLowerCase() !== "can-i") throw new Error("only kubectl auth can-i is allowed");
  if (command === "cluster-info" && args[1]?.toLowerCase() === "dump") throw new Error("kubectl cluster-info dump is not allowed");
  return { args, mutating: false, targets: [] };
}

export function validateKubectlAdminRequest(value: unknown, input: unknown): KubectlRequest {
  const args = validateArgs(value, true);
  const stdin = validateStdin(input);
  return {
    args,
    mutating: true,
    stdin,
    targets: [args[0]],
    stdinSha256: stdin === undefined ? undefined : createHash("sha256").update(stdin).digest("hex"),
  };
}

export function validateKubectlArgs(value: unknown): string[] {
  return validateKubectlReadRequest(value).args;
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
