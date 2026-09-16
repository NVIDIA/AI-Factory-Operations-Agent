// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { diagnosticExecArgv, isAllowedDiagnosticArgv } from "./diagnostic-policy.ts";

const AUTOMATION_SESSION = /(?:^|:)mosaic-automation-(cluster-monitor|alert)-[a-z0-9][a-z0-9_-]*(?::|$)/i;

const ALWAYS_MUTATING_TOOLS = new Set([
  "apply_patch",
  "bcm_add_note",
  "bcm_execute_cmsh_admin",
  "bcm_remove_note",
  "edit",
  "request_mcp_connection",
  "run_kubectl_admin",
  "write",
]);

const READ_ONLY_TOOLS = new Set([
  "agents_list",
  "bcm_execute_cmsh",
  "bcm_execute_tool",
  "bcm_get_info",
  "bcm_health",
  "bcm_list_notes",
  "bcm_node_health_summary",
  "bcm_search_notes",
  "bcm_search_tools",
  "dashboard_create",
  "dashboard_list",
  "dashboard_open",
  "dcgm_current",
  "dcgm_health",
  "dcgm_metric_names",
  "dcgm_raw_metric",
  "dcgm_top",
  "find",
  "get_goal",
  "glob",
  "grafana_dashboard_create",
  "grafana_dashboard_health",
  "grafana_dashboard_open",
  "grafana_dashboard_presets",
  "grafana_dashboard_validate",
  "hardware_analyze_dut",
  "hardware_health",
  "hardware_triage_list",
  "hardware_triage_report",
  "hardware_triage_status",
  "image",
  "iraop_get_document",
  "iraop_list_collections",
  "iraop_list_documents",
  "iraop_query",
  "grep",
  "ls",
  "memory_get",
  "memory_search",
  "node_grep_files",
  "node_read_file",
  "observability_metric_names",
  "observability_query",
  "observability_range_query",
  "pdf",
  "read",
  "run_kubectl",
  "search",
  "sessions_history",
  "sessions_list",
  "slurm_job_evidence",
  "tool_describe",
  "tool_search",
  "update_plan",
  "web_fetch",
  "web_search",
  "x_search",
]);

export type ToolAccess = "read" | "edit" | "unknown";

export type AccessMode = "view" | "edit" | "auto";

export type RunAccess = {
  mode: AccessMode;
  provider?: string;
  senderId?: string;
};

export type ToolContext = {
  runId?: string;
  sessionKey?: string;
  getSessionExtension?: (namespace: string) => unknown;
};

export type ApprovalRequest = {
  toolCallId?: string;
  toolName?: string;
  title: string;
  description: string;
  severity?: "info" | "warning" | "critical";
  timeoutMs?: number;
};

export type ApprovalDecision = "allow" | "deny" | "timeout";

type McpToolPolicy = {
  defaultAccess: "read" | "edit";
  viewTools: Set<string>;
};

const runAccess = new Map<string, RunAccess>();
const mcpToolPolicies = new Map<string, McpToolPolicy>();
let identityApprovalBroker: ((access: RunAccess, request: ApprovalRequest) => Promise<ApprovalDecision>) | undefined;

export function configureMcpToolPolicies(value: unknown) {
  mcpToolPolicies.clear();
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [server, raw] of Object.entries(value)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const policy = raw as { defaultAccess?: unknown; viewTools?: unknown };
    mcpToolPolicies.set(`${server.toLowerCase()}__`, {
      defaultAccess: policy.defaultAccess === "view" ? "read" : "edit",
      viewTools: new Set(
        Array.isArray(policy.viewTools)
          ? policy.viewTools.filter((tool): tool is string => typeof tool === "string").map(tool => tool.toLowerCase())
          : [],
      ),
    });
  }
}

export function readonlyAutomationSource(sessionKey: unknown) {
  if (typeof sessionKey !== "string") return undefined;
  return sessionKey.match(AUTOMATION_SESSION)?.[1]?.toLowerCase();
}

export function isReadonlyAutomationSession(sessionKey: unknown) {
  return readonlyAutomationSource(sessionKey) !== undefined;
}

export function sessionAccessMode(state: unknown) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return "view";
  const mode = (state as { mode?: unknown }).mode;
  return mode === "edit" || mode === "auto" ? mode : "view";
}

export function setRunAccess(runId: unknown, access: RunAccess) {
  if (typeof runId === "string" && runId) runAccess.set(runId, access);
}

export function clearRunAccess(runId: unknown) {
  if (typeof runId === "string") runAccess.delete(runId);
}

export function runAccessMode(context: ToolContext) {
  if (context.runId && runAccess.has(context.runId)) return runAccess.get(context.runId)!.mode;
  return sessionAccessMode(context.getSessionExtension?.("access"));
}

export function runAccessIdentity(context: ToolContext) {
  return context.runId ? runAccess.get(context.runId) : undefined;
}

export function configureIdentityApprovalBroker(
  broker?: (access: RunAccess, request: ApprovalRequest) => Promise<ApprovalDecision>,
) {
  identityApprovalBroker = broker;
}

export async function requestIdentityApproval(context: ToolContext, request: ApprovalRequest) {
  const access = runAccessIdentity(context);
  if (access?.provider !== "slack") return undefined;
  if (access.mode !== "edit" || !identityApprovalBroker) return "deny";
  return identityApprovalBroker(access, request);
}

export const sessionAccessExtension = {
  namespace: "access",
  description: "Per-conversation access mode",
  project: ({ state }: { state: unknown }) => ({ mode: sessionAccessMode(state) }),
};

export function sessionAllowsEdit(sessionKey: unknown, state: unknown) {
  return !isReadonlyAutomationSession(sessionKey) && sessionAccessMode(state) !== "view";
}

export function sessionSkipsApproval(sessionKey: unknown, state: unknown) {
  return !isReadonlyAutomationSession(sessionKey) && sessionAccessMode(state) === "auto";
}

export function contextAllowsEdit(context: ToolContext) {
  return !isReadonlyAutomationSession(context.sessionKey) && runAccessMode(context) !== "view";
}

export function contextAllowsMutation(editEnabled: boolean, context: ToolContext) {
  return editEnabled && contextAllowsEdit(context);
}

export function contextSkipsApproval(context: ToolContext) {
  return !isReadonlyAutomationSession(context.sessionKey) && runAccessMode(context) === "auto";
}

export function toolAccess(toolName: unknown, params?: unknown): ToolAccess {
  if (typeof toolName !== "string") return "unknown";
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "exec") return diagnosticExecArgv(params) === undefined ? "edit" : "read";
  if (normalized === "run_remote_ssh") {
    const argv = params && typeof params === "object" && !Array.isArray(params)
      ? (params as { argv?: unknown }).argv
      : undefined;
    return isAllowedDiagnosticArgv(argv) ? "read" : "edit";
  }
  if (ALWAYS_MUTATING_TOOLS.has(normalized)) return "edit";
  if (READ_ONLY_TOOLS.has(normalized)) return "read";
  for (const [prefix, policy] of mcpToolPolicies) {
    if (!normalized.startsWith(prefix)) continue;
    const tool = normalized.slice(prefix.length);
    return policy.defaultAccess === "read" || policy.viewTools.has(tool) ? "read" : "edit";
  }
  return "unknown";
}

export function toolRequiresEdit(toolName: unknown, params?: unknown) {
  return toolAccess(toolName, params) !== "read";
}
