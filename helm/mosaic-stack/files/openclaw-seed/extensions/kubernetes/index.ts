// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { isKubectlExecFallback, resolveCluster, validateKubectlArgs } from "./policy.ts";
import { runKubectl } from "./runner.ts";

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

function toolResult(payload: { command: string[]; [key: string]: unknown }) {
  const { command, ...result } = payload;
  return {
    content: [{ type: "text", text: `${command.join(" ")}\n${JSON.stringify(result, null, 2)}` }],
    details: payload,
  };
}

export default definePluginEntry({
  id: "kubernetes",
  name: "Kubernetes",
  description: "Read-only kubectl access to registered Kubernetes clusters.",
  register(api) {
    const settings = config(api.pluginConfig);

    api.on(
      "before_tool_call",
      (event) =>
        isKubectlExecFallback(event.toolName, event.params)
          ? {
              block: true,
              blockReason:
                "Kubernetes commands are available only through the read-only run_kubectl tool. Do not retry with exec.",
            }
          : undefined,
    );

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
        let args: string[];
        try {
          args = validateKubectlArgs(rawParams.args);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "kubectl request was rejected";
          return toolResult({
            command: ["kubectl", "<rejected>"],
            blocked: true,
            reason,
            exitCode: null,
            stdout: "",
            stderr: reason,
          });
        }
        const cluster = resolveCluster(rawParams.cluster, settings.defaultCluster, settings.clusters);
        const result = await runKubectl(
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
          stdout: result.stdout,
          stderr: result.stderr,
        });
      },
    });
  },
});
