// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { runMutationOnce } from "../mutation-ledger.ts";
import {
  formatKubectlApproval,
  isKubectlExecFallback,
  resolveCluster,
  validateKubectlAdminRequest,
  validateKubectlReadRequest,
  type KubectlRequest,
  type KubernetesClusterConfig,
} from "./policy.ts";
import { runKubectl } from "./runner.ts";

type KubernetesConfig = {
  command?: string;
  defaultCluster?: string;
  clusters?: Record<string, string | KubernetesClusterConfig>;
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

function rejectedResult(error: unknown) {
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

async function executeRequest(
  settings: Required<KubernetesConfig>,
  toolCallId: string,
  toolName: string,
  rawParams: Record<string, unknown>,
  request: KubectlRequest,
) {
  const cluster = resolveCluster(rawParams.cluster, settings.defaultCluster, settings.clusters);
  const execute = () => runKubectl(
    settings.command,
    request.args,
    cluster.kubeconfig,
    settings.timeoutMs,
    settings.maxOutputBytes,
    request.manifest,
    cluster.server,
    cluster.tlsServerName,
  );
  const attempt = request.mutating
    ? await runMutationOnce({
        toolCallId,
        toolName,
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
}

export default definePluginEntry({
  id: "kubernetes",
  name: "Kubernetes",
  description: "Read-only kubectl access to registered Kubernetes clusters.",
  register(api) {
    const settings = config(api.pluginConfig);

    api.on("before_tool_call", (event, context) => {
      if (isKubectlExecFallback(event.toolName, event.params)) {
        return {
          block: true,
          blockReason: "Kubernetes commands are available only through run_kubectl. Do not retry with exec.",
        };
      }
      try {
        if (event.toolName === "run_kubectl") {
          validateKubectlReadRequest(event.params.args);
          return;
        }
        if (event.toolName !== "run_kubectl_admin") return;
        const request = validateKubectlAdminRequest(event.params.args, event.params.manifest);
        if (!settings.hitl) return;
        const cluster = resolveCluster(event.params.cluster, settings.defaultCluster, settings.clusters);
        const approval = formatKubectlApproval(request, cluster.name);
        return {
          requireApproval: {
            ...approval,
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
        "Run one read-only kubectl operation against a registered cluster. Pass argv without the kubectl prefix. The Kubernetes credential enforces read-only access. Mutations use run_kubectl_admin when edit mode is enabled. Interactive access, Secrets, credential overrides, and shell syntax are rejected.",
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
            description: "kubectl arguments beginning with a supported read command.",
          },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        try {
          return await executeRequest(
            settings,
            toolCallId,
            "run_kubectl",
            rawParams,
            validateKubectlReadRequest(rawParams.args),
          );
        } catch (error) {
          return rejectedResult(error);
        }
      },
    });

    if (settings.editEnabled) api.registerTool({
      name: "run_kubectl_admin",
      label: "Kubernetes Admin",
      description:
        "Apply one structured workload manifest or delete one exact named workload resource. This tool always uses edit capability and may require approval. Use run_kubectl for every read.",
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
            description: "Exactly one supported apply or delete operation without the kubectl prefix.",
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
            description: "One structured Kubernetes object required by kubectl apply -f -.",
          },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        try {
          return await executeRequest(
            settings,
            toolCallId,
            "run_kubectl_admin",
            rawParams,
            validateKubectlAdminRequest(rawParams.args, rawParams.manifest),
          );
        } catch (error) {
          return rejectedResult(error);
        }
      },
    });
  },
});
