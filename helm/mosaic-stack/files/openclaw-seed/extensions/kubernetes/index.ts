// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveCluster, validateKubectlArgs } from "./policy.ts";

type KubernetesConfig = {
  command?: string;
  defaultCluster?: string;
  clusters?: Record<string, string>;
  maxOutputBytes?: number;
  timeoutMs?: number;
};

function config(value: unknown): Required<KubernetesConfig> {
  const raw = value && typeof value === "object" ? (value as KubernetesConfig) : {};
  return {
    command: raw.command || "/tools/kubectl",
    defaultCluster: raw.defaultCluster || "local",
    clusters: raw.clusters || {},
    maxOutputBytes: raw.maxOutputBytes || 1_048_576,
    timeoutMs: raw.timeoutMs || 60_000,
  };
}

function toolResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function run(command: string, args: string[], kubeconfig: string, timeoutMs: number, maxOutputBytes: number) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, ["--kubeconfig", kubeconfig, ...args], {
      env: { ...process.env, KUBECONFIG: kubeconfig },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
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
      else resolve({ code, stdout, stderr });
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        finish(new Error("kubectl output exceeded " + maxOutputBytes + " bytes"));
        return;
      }
      if (target === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };

    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(undefined, code ?? -1));

    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("kubectl timed out after " + timeoutMs + " ms"));
    }, timeoutMs);
  });
}

export default definePluginEntry({
  id: "kubernetes",
  name: "Kubernetes",
  description: "Read-only kubectl access to registered Kubernetes clusters.",
  register(api) {
    const settings = config(api.pluginConfig);

    api.registerTool({
      name: "run_kubectl",
      label: "Kubernetes Agent",
      description:
        "Run one read-only kubectl operation against a registered cluster. Pass argv without the kubectl prefix. Mutation, interactive access, Secrets, and credential overrides are rejected.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["args"],
        properties: {
          cluster: {
            type: "string",
            description: "Registered cluster name. Defaults to " + settings.defaultCluster + ".",
          },
          args: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            items: { type: "string" },
            description: "kubectl arguments, beginning with a read-only command such as get, describe, or logs.",
          },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const args = validateKubectlArgs(rawParams.args);
        const cluster = resolveCluster(rawParams.cluster, settings.defaultCluster, settings.clusters);
        const result = await run(
          settings.command,
          args,
          cluster.kubeconfig,
          settings.timeoutMs,
          settings.maxOutputBytes,
        );
        return toolResult({
          cluster: cluster.name,
          command: ["kubectl", ...args],
          exitCode: result.code,
          stdout: result.stdout.replaceAll(cluster.kubeconfig, "<kubeconfig>"),
          stderr: result.stderr.replaceAll(cluster.kubeconfig, "<kubeconfig>"),
        });
      },
    });
  },
});
