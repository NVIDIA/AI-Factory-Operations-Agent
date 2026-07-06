// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const READ_ONLY_COMMANDS = new Set([
  "api-resources",
  "api-versions",
  "auth",
  "cluster-info",
  "describe",
  "explain",
  "get",
  "logs",
  "top",
  "version",
]);

const FORBIDDEN_FLAGS = new Set([
  "--as",
  "--as-group",
  "--as-uid",
  "--certificate-authority",
  "--client-certificate",
  "--client-key",
  "--cluster",
  "--context",
  "--insecure-skip-tls-verify",
  "--kubeconfig",
  "--password",
  "--raw",
  "--server",
  "--token",
  "--user",
  "--username",
]);

const FORBIDDEN_SHORT_FLAGS = new Set(["-s"]);

const SECRET_RESOURCE = /(^|[./])secrets?($|[./])/i;

function flagName(arg: string) {
  return arg.startsWith("--") ? arg.split("=", 1)[0] : arg;
}

function referencesSecret(args: string[]) {
  return args.some((arg) =>
    arg
      .split(",")
      .filter(Boolean)
      .some((part) => SECRET_RESOURCE.test(part)),
  );
}

export function validateKubectlArgs(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("args must be a non-empty string array");
  if (value.length > 64) throw new Error("args cannot contain more than 64 entries");

  const args = value.map((arg) => {
    if (typeof arg !== "string" || !arg || arg.length > 4096 || /[\0\r\n]/.test(arg)) {
      throw new Error("each kubectl argument must be a non-empty single-line string no longer than 4096 characters");
    }
    return arg;
  });

  const command = args[0].toLowerCase();
  if (!READ_ONLY_COMMANDS.has(command)) throw new Error("kubectl command is not read-only: " + args[0]);

  for (const arg of args) {
    const flag = flagName(arg);
    if (FORBIDDEN_FLAGS.has(flag) || FORBIDDEN_SHORT_FLAGS.has(flag)) {
      throw new Error("kubectl option is not allowed: " + flag);
    }
  }

  if (command === "auth" && args[1]?.toLowerCase() !== "can-i") {
    throw new Error("only kubectl auth can-i is allowed");
  }
  if (command === "cluster-info" && args[1]?.toLowerCase() === "dump") {
    throw new Error("kubectl cluster-info dump is not allowed");
  }
  if ((command === "get" || command === "describe") && referencesSecret(args.slice(1))) {
    throw new Error("Kubernetes Secret resources are not accessible");
  }

  return args;
}

export function resolveCluster(
  requested: unknown,
  defaultCluster: string,
  clusters: Record<string, string>,
) {
  if (requested !== undefined && (typeof requested !== "string" || !requested.trim())) {
    throw new Error("cluster must be a non-empty string");
  }
  const name = typeof requested === "string" ? requested.trim() : defaultCluster;
  const kubeconfig = clusters[name];
  if (!kubeconfig) throw new Error("unknown Kubernetes cluster: " + name);
  return { name, kubeconfig };
}
