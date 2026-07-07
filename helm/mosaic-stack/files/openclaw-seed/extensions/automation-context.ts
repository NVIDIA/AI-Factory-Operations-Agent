// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const AUTOMATION_SESSION = /(?:^|:)mosaic-automation-(cluster-monitor|alert)-[a-z0-9][a-z0-9_-]*(?::|$)/i;
const MUTATION_TOOLS = new Set([
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

export function blocksAutomationTool(toolName: unknown, sessionKey: unknown) {
  return typeof toolName === "string"
    && isReadonlyAutomationSession(sessionKey)
    && MUTATION_TOOLS.has(toolName.trim().toLowerCase());
}
