// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { runMutationOnce } from "../mutation-ledger.ts";
import { classifyKubectlRequest, isKubectlExecFallback, resolveCluster } from "./policy.ts";
import { runKubectl } from "./runner.ts";

type KubernetesConfig = {
  command?: string;
  defaultCluster?: string;
  clusters?: Record<string, string>;
  maxOutputBytes?: number;
  timeoutMs?: number;
  editEnabled?: boolean;
  hitl?: boolean;
  approvalTimeoutMs?: number;
};

function config(value: unknown): Required<KubernetesConfig> {
  const raw = value && typeof value === "object" ? (value as KubernetesConfig) : {};
  return {
    command: raw.command || "/tools/kubectl",
    defaultCluster: raw.defaultCluster || "local",
    clusters: raw.clusters || {},
    maxOutputBytes: raw.maxOutputBytes || 1_048_576,
    timeoutMs: raw.timeoutMs || 60_000,
    editEnabled: raw.editEnabled === true,
    hitl: raw.hitl !== false,
    approvalTimeoutMs: raw.approvalTimeoutMs || 120_000,
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

    api.on("before_tool_call", (event) => {
      if (isKubectlExecFallback(event.toolName, event.params)) {
        return {
          block: true,
          blockReason: "Kubernetes commands are available only through run_kubectl. Do not retry with exec.",
        };
      }
      if (event.toolName !== "run_kubectl") return;
      try {
        const request = classifyKubectlRequest(event.params.args, event.params.manifest, settings.editEnabled);
        if (!request.mutating || !settings.hitl) return;
        const cluster = resolveCluster(event.params.cluster, settings.defaultCluster, settings.clusters);
        const target = request.targets.join(", ");
        const digest = request.manifestSha256 ? ` Manifest SHA-256: ${request.manifestSha256}.` : "";
        return {
          requireApproval: {
            title: `${request.args[0]} ${request.targets[0]}`.slice(0, 80),
            description: `${request.args[0]} ${target} on Kubernetes cluster ${cluster.name}.${digest}`.slice(0, 256),
            severity: "warning",
            timeoutMs: settings.approvalTimeoutMs,
            timeoutBehavior: "deny",
          },
        };
      } catch (error) {
        return {
          block: true,
          blockReason: error instanceof Error ? error.message : "kubectl request was rejected",
        };
      }
    });

    api.registerTool({
      name: "run_kubectl",
      label: "Kubernetes Agent",
      description:
        "Run one kubectl operation against a registered cluster. Pass argv without the kubectl prefix. Read operations are always available. When edit mode is enabled, apply accepts an inline manifest and delete requires an exact resource name; HITL may require approval. Interactive access, Secrets, credential overrides, and shell syntax are rejected. If blocked, never retry with exec or another tool.",
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
            description: "kubectl arguments beginning with a supported read command, or apply/delete when edit mode is enabled.",
          },
          manifest: {
            type: "object",
            required: ["apiVersion", "kind", "metadata"],
            properties: {
              apiVersion: { type: "string" },
              kind: { type: "string" },
              metadata: {
                type: "object",
                required: ["name", "namespace"],
                properties: {
                  name: { type: "string" },
                  namespace: { type: "string" },
                },
              },
            },
            description: "One structured Kubernetes object required by kubectl apply -f -. Never pass YAML or a file path.",
          },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        let request;
        try {
          request = classifyKubectlRequest(rawParams.args, rawParams.manifest, settings.editEnabled);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "kubectl request was rejected";
          return toolResult({
            command: ["kubectl", "<rejected>"],
            blocked: true,
            executed: false,
            reason,
            exitCode: null,
            stdout: "",
            stderr: reason,
          });
        }
        const cluster = resolveCluster(rawParams.cluster, settings.defaultCluster, settings.clusters);
        const execute = () => runKubectl(
          settings.command,
          request.args,
          cluster.kubeconfig,
          settings.timeoutMs,
          settings.maxOutputBytes,
          request.manifest,
        );
        const attempt = request.mutating
          ? await runMutationOnce({
              toolCallId,
              toolName: "run_kubectl",
              target: `${cluster.name}:${request.targets.join(",")}`,
              args: { args: request.args, manifestSha256: request.manifestSha256 },
            }, execute, value => value.code === 0 ? "completed" : "failed")
          : { replayed: false as const, state: "completed" as const, result: await execute() };
        if (attempt.replayed) return toolResult({
          cluster: cluster.name,
          command: ["kubectl", ...request.args],
          mutating: true,
          replayed: true,
          executed: false,
          idempotencyKey: toolCallId,
          previousStatus: attempt.state,
        });
        const execution = attempt.result;
        return toolResult({
          cluster: cluster.name,
          command: ["kubectl", ...request.args],
          mutating: request.mutating,
          idempotencyKey: request.mutating ? toolCallId : undefined,
          targets: request.targets,
          manifestSha256: request.manifestSha256,
          exitCode: execution.code,
          stdout: execution.stdout,
          stderr: execution.stderr,
        });
      },
    });
  },
});
