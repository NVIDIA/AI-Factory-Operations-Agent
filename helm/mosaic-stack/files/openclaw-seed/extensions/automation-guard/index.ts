// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  isReadonlyAutomationSession,
  sessionAccessMode,
  sessionAllowsEdit,
  toolRequiresEdit,
} from "../automation-context.ts";

export default definePluginEntry({
  id: "automation-guard",
  name: "Automation Guard",
  description: "Enforces read-only automation and per-conversation view mode.",
  register(api) {
    const editEnabled = Boolean(
      api.pluginConfig
      && typeof api.pluginConfig === "object"
      && !Array.isArray(api.pluginConfig)
      && (api.pluginConfig as { editEnabled?: unknown }).editEnabled === true,
    );
    api.session.state.registerSessionExtension({
      namespace: "access",
      description: "Mosaic per-conversation access mode",
      project: ({ state }) => ({ mode: sessionAccessMode(state) }),
    });
    api.registerTrustedToolPolicy({
      id: "session-access",
      description: "Blocks mutating tools in automated and view-mode sessions.",
      evaluate(event, context) {
        let mutating = false;
        try {
          mutating = toolRequiresEdit(event.toolName);
        } catch {
          mutating = true;
        }
        if (!mutating) return;
        const automated = isReadonlyAutomationSession(context.sessionKey);
        if (!automated && (!editEnabled || sessionAllowsEdit(
          context.sessionKey,
          context.getSessionExtension?.("access"),
        ))) return;
        const reason = automated
          ? "Automated Mosaic sessions are read-only."
          : "This conversation is in View mode. Switch it to Edit before requesting changes.";
        return {
          block: true,
          blockReason: `${reason} Mutation and generic execution tools are unavailable.`,
        };
      },
    });
  },
});
