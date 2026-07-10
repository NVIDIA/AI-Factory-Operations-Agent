// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  isReadonlyAutomationSession,
  contextSkipsApproval,
  requestIdentityApproval,
  sessionAccessExtension,
} from "../automation-context.ts";
import { isAllowedDiagnosticArgv } from "../diagnostic-policy.ts";
import { runMutationOnce } from "../mutation-ledger.ts";
import { classifySshRequest, normalizeHosts } from "./policy.ts";
import { runSsh } from "./runner.ts";

type RemoteSshConfig = {
  command?: string;
  keyPath?: string;
  knownHostsPath?: string;
  hosts?: unknown;
  hitl?: boolean;
  approvalTimeoutMs?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
};

function config(value: unknown) {
  const raw = value && typeof value === "object" ? value as RemoteSshConfig : {};
  return {
    command: raw.command || "/tools/ssh",
    keyPath: raw.keyPath || "/var/run/mosaic-ssh/id",
    knownHostsPath: raw.knownHostsPath || "/var/run/mosaic-ssh/known_hosts",
    hosts: normalizeHosts(raw.hosts),
    hitl: raw.hitl !== false,
    approvalTimeoutMs: raw.approvalTimeoutMs || 120_000,
    timeoutMs: raw.timeoutMs || 60_000,
    maxOutputBytes: raw.maxOutputBytes || 65_536,
  };
}

function result(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export default definePluginEntry({
  id: "remote-ssh",
  name: "Remote SSH",
  description: "Constrained argv execution on configured remote hosts.",
  register(api) {
    const settings = config(api.pluginConfig);
    api.session.state.registerSessionExtension(sessionAccessExtension);

    api.registerTrustedToolPolicy({
      id: "remote-ssh-access",
      description: "Validates remote commands and requires approval for Edit mutations.",
      async evaluate(event, context) {
        if (event.toolName !== "run_remote_ssh") return;
        if (isReadonlyAutomationSession(context.sessionKey)) {
          return {
            block: true,
            blockReason: "Automated Mosaic sessions cannot run remote SSH commands.",
          };
        }
        try {
          const request = classifySshRequest(event.params, settings.hosts);
          if (isAllowedDiagnosticArgv(request.argv) || !settings.hitl || contextSkipsApproval(context)) return;
          const approval = {
            title: `Remote command on ${request.host.alias}`.slice(0, 80),
            description: `${JSON.stringify(request.argv)} on ${request.host.alias} (${request.host.user}@${request.host.address}:${request.host.port})`.slice(0, 256),
            severity: "critical" as const,
            timeoutMs: settings.approvalTimeoutMs,
          };
          const identityDecision = await requestIdentityApproval(context, approval);
          if (identityDecision === "allow") return;
          if (identityDecision) return {
            block: true,
            blockReason: identityDecision === "timeout" ? "Approval timed out." : "Action denied by user.",
          };
          return {
            requireApproval: {
              ...approval,
              timeoutBehavior: "deny",
            },
          };
        } catch (error) {
          return {
            block: true,
            blockReason: error instanceof Error ? error.message : "remote SSH request was rejected",
          };
        }
      },
    });

    api.registerTool({
      name: "run_remote_ssh",
      label: "Remote SSH",
      description: "Run one exact argv command on a configured remote host. Allowlisted read-only diagnostics run without approval; all other commands require Edit and approval when HITL is enabled. Host aliases are fixed by the installer; SSH options, credentials, destinations, nested SSH, and shell-style command strings are not accepted.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["host", "argv"],
        properties: {
          host: {
            type: "string",
            enum: settings.hosts.map((host) => host.alias),
            description: "Configured remote host alias.",
          },
          argv: {
            type: "array",
            minItems: 1,
            maxItems: 64,
            items: { type: "string", minLength: 1, maxLength: 1024 },
            description: "Exact remote program and arguments. Do not include ssh or connection options.",
          },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        try {
          const request = classifySshRequest(rawParams, settings.hosts);
          const diagnostic = isAllowedDiagnosticArgv(request.argv);
          if (diagnostic) {
            const execution = await runSsh(settings, request.host, request.remoteCommand);
            return result({
              host: request.host.alias,
              argv: request.argv,
              diagnostic: true,
              exitCode: execution.code,
              stdout: execution.stdout,
              stderr: execution.stderr,
            });
          }
          const attempt = await runMutationOnce({
            toolCallId,
            toolName: "run_remote_ssh",
            target: request.host.alias,
            args: request.argv,
          }, () => runSsh(settings, request.host, request.remoteCommand),
          value => value.code === 0 ? "completed" : "failed");
          if (attempt.replayed) return result({
            host: request.host.alias,
            argv: request.argv,
            diagnostic: false,
            replayed: true,
            executed: false,
            idempotencyKey: toolCallId,
            previousStatus: attempt.state,
          });
          const execution = attempt.result;
          return result({
            host: request.host.alias,
            argv: request.argv,
            idempotencyKey: toolCallId,
            exitCode: execution.code,
            stdout: execution.stdout,
            stderr: execution.stderr,
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : "remote SSH request failed";
          return result({
            blocked: true,
            executed: false,
            reason,
            exitCode: null,
            stdout: "",
            stderr: reason,
          });
        }
      },
    });
  },
});
