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
  "run_kubectl_admin",
  "write",
]);

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

const runAccess = new Map<string, RunAccess>();
let identityApprovalBroker: ((access: RunAccess, request: ApprovalRequest) => Promise<ApprovalDecision>) | undefined;

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

export function contextSkipsApproval(context: ToolContext) {
  return !isReadonlyAutomationSession(context.sessionKey) && runAccessMode(context) === "auto";
}

export function toolRequiresEdit(toolName: unknown, params?: unknown) {
  if (typeof toolName !== "string") return false;
  const normalized = toolName.trim().toLowerCase();
  if (normalized === "exec") return diagnosticExecArgv(params) === undefined;
  if (normalized === "run_remote_ssh") {
    const argv = params && typeof params === "object" && !Array.isArray(params)
      ? (params as { argv?: unknown }).argv
      : undefined;
    return !isAllowedDiagnosticArgv(argv);
  }
  return ALWAYS_MUTATING_TOOLS.has(normalized);
}
