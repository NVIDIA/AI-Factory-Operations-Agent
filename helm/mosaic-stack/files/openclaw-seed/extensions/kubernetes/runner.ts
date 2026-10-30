// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { resolveCluster, type KubectlRequest, type KubernetesClusterConfig } from "./policy.ts";

export function kubectlArgv(
  kubeconfig: string,
  args: string[],
  server?: string,
  tlsServerName?: string,
) {
  const separator = args.indexOf("--");
  const clientArgs = separator < 0 ? args : args.slice(0, separator);
  if (clientArgs.some(arg => arg === "--kubeconfig" || arg.startsWith("--kubeconfig="))) return args;
  return [
    "--kubeconfig", kubeconfig,
    ...(server ? ["--server", server] : []),
    ...(tlsServerName ? ["--tls-server-name", tlsServerName] : []),
    ...args,
  ];
}

export function runKubectl(
  command: string,
  args: string[],
  kubeconfig: string,
  timeoutMs: number,
  maxOutputBytes: number,
  stdin?: string,
  server?: string,
  tlsServerName?: string,
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, kubectlArgv(kubeconfig, args, server, tlsServerName), {
      env: { ...process.env, KUBECONFIG: kubeconfig },
      shell: false,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error, code = -1) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else {
        resolve({
          code,
          stdout: stdout.replaceAll(kubeconfig, "<kubeconfig>"),
          stderr: stderr.replaceAll(kubeconfig, "<kubeconfig>"),
        });
      }
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        finish(new Error("kubectl output exceeded " + maxOutputBytes + " bytes"));
      } else if (target === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };

    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    if (stdin !== undefined) child.stdin?.end(stdin);
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(undefined, code ?? -1));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("kubectl timed out after " + timeoutMs + " ms"));
    }, timeoutMs);
  });
}

export function toolResult(payload: { command: string[]; [key: string]: unknown }) {
  const { command, stdout, stderr, ...result } = payload;
  return {
    content: [
      { type: "text", text: `${command.join(" ")}\n${JSON.stringify(result, null, 2)}` },
      ...Object.entries({ stdout, stderr }).flatMap(([name, value]) =>
        typeof value === "string" && value ? [{ type: "text", text: `${name}:\n${value}` }] : []),
    ],
    isError: payload.blocked === true || payload.previousStatus === "failed"
      || (typeof payload.exitCode === "number" && payload.exitCode !== 0),
    details: payload,
  };
}


export async function kubectlTarget(
  settings: {
    command: string;
    defaultCluster: string;
    clusters: Record<string, string | KubernetesClusterConfig>;
    timeoutMs: number;
    maxOutputBytes: number;
    remoteSsh?: unknown;
  },
  params: Record<string, unknown>,
  request: KubectlRequest,
) {
  if (params.host !== undefined) {
    if (!request.mutating) throw new Error("Host execution requires the Kubernetes admin tool");
    if (!settings.remoteSsh) throw new Error("Remote Kubernetes execution requires configured SSH access");
    if (params.cluster !== undefined) throw new Error("Choose either a registered cluster or an SSH host");
    const { remoteSshConfig, classifySshRequest } = await import("../remote-ssh/policy.ts");
    const { runSsh } = await import("../remote-ssh/runner.ts");
    const ssh = remoteSshConfig(settings.remoteSsh);
    const remote = classifySshRequest({ host: params.host, argv: ["kubectl", ...request.args] }, ssh.hosts);
    return {
      name: `ssh:${remote.host.alias} (${remote.host.user}@${remote.host.address}:${remote.host.port})`,
      execute: () => runSsh(ssh, remote.host, remote.remoteCommand, request.stdin),
    };
  }
  const cluster = resolveCluster(params.cluster, settings.defaultCluster, settings.clusters);
  return {
    name: cluster.name,
    execute: () => runKubectl(settings.command, request.args, cluster.kubeconfig,
      settings.timeoutMs, settings.maxOutputBytes, request.stdin, cluster.server, cluster.tlsServerName),
  };
}
