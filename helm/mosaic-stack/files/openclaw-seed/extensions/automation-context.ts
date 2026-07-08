// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const AUTOMATION_SESSION = /(?:^|:)mosaic-automation-(cluster-monitor|alert)-[a-z0-9][a-z0-9_-]*(?::|$)/i;
import { classifyCmshRequest } from "./bcm-policy.ts";
import { classifyKubectlRequest } from "./kubernetes-policy.ts";

const ALWAYS_MUTATING_TOOLS = new Set([
  "apply_patch",
  "bcm_add_note",
  "bcm_remove_note",
  "edit",
  "exec",
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

export function toolRequiresEdit(toolName: unknown, params: Record<string, unknown> = {}) {
  if (typeof toolName !== "string") return false;
  const name = toolName.trim().toLowerCase();
  if (ALWAYS_MUTATING_TOOLS.has(name)) return true;
  if (name === "run_kubectl") {
    return classifyKubectlRequest(params.args, params.manifest, true).mutating;
  }
  if (name === "bcm_execute_cmsh") {
    return classifyCmshRequest(params.commands, true).mutating;
  }
  return false;
}
