// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const AUTOMATION_SESSION = /(?:^|:)mosaic-automation-(cluster-monitor|alert)-[a-z0-9][a-z0-9_-]*(?::|$)/i;

const ALWAYS_MUTATING_TOOLS = new Set([
  "apply_patch",
  "bcm_add_note",
  "bcm_execute_cmsh_admin",
  "bcm_remove_note",
  "edit",
  "exec",
  "run_kubectl_admin",
  "run_remote_ssh",
  "write",
]);

export function readonlyAutomationSource(sessionKey: unknown) {
  if (typeof sessionKey !== "string") return undefined;
  return sessionKey.match(AUTOMATION_SESSION)?.[1]?.toLowerCase();
}

export function isReadonlyAutomationSession(sessionKey: unknown) {
  return readonlyAutomationSource(sessionKey) !== undefined;
}

export function sessionAccessMode(state: unknown) {
  if (!state || typeof state !== "object" || Array.isArray(state)) return "view";
  return (state as { mode?: unknown }).mode === "edit" ? "edit" : "view";
}

export function sessionAllowsEdit(sessionKey: unknown, state: unknown) {
  return !isReadonlyAutomationSession(sessionKey) && sessionAccessMode(state) === "edit";
}

export function toolRequiresEdit(toolName: unknown) {
  if (typeof toolName !== "string") return false;
  return ALWAYS_MUTATING_TOOLS.has(toolName.trim().toLowerCase());
}
