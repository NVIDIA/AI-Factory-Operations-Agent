// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  clearRunAccess,
  configureIdentityApprovalBroker,
  contextAllowsMutation,
  isReadonlyAutomationSession,
  sessionAccessExtension,
  setRunAccess,
  toolRequiresEdit,
} from "../automation-context.ts";
import { installSlackApprovalBroker } from "./slack-approval.ts";

export default definePluginEntry({
  id: "automation-guard",
  name: "Automation Guard",
  description: "Enforces read-only automation and per-conversation View, Edit, and Auto modes.",
  register(api) {
    const editEnabled = Boolean(
      api.pluginConfig
      && typeof api.pluginConfig === "object"
      && !Array.isArray(api.pluginConfig)
      && (api.pluginConfig as { editEnabled?: unknown }).editEnabled === true,
    );
    const pluginConfig = api.pluginConfig && typeof api.pluginConfig === "object" && !Array.isArray(api.pluginConfig)
      ? api.pluginConfig as Record<string, unknown>
      : {};
    const slackEnabled = pluginConfig.slackEnabled === true;
    const slackEditUserIds = Array.isArray(pluginConfig.slackEditUserIds)
      ? pluginConfig.slackEditUserIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    if (slackEnabled) {
      configureIdentityApprovalBroker(installSlackApprovalBroker(api, slackEditUserIds));
      api.on("before_prompt_build", (_event, context) => {
        if (context.channel !== "slack" && context.messageProvider !== "slack") return;
        const mode = editEnabled && context.senderId && slackEditUserIds.includes(context.senderId)
          ? "edit"
          : "view";
        setRunAccess(context.runId, {
          mode,
          provider: "slack",
          ...(context.senderId ? { senderId: context.senderId } : {}),
        });
        return {
          prependContext: `[Runtime Context]\nai_factory_operations_agent_access_mode=${mode}\nThis access mode is authoritative for the current Slack user.`,
        };
      });
      api.on("agent_end", (_event, context) => clearRunAccess(context.runId));
    }
    api.session.state.registerSessionExtension(sessionAccessExtension);
    api.registerTrustedToolPolicy({
      id: "session-access",
      description: "Blocks mutating tools in automated and view-mode sessions.",
      evaluate(event, context) {
        let mutating = false;
        try {
          mutating = toolRequiresEdit(event.toolName, event.params);
        } catch {
          mutating = true;
        }
        if (!mutating) return;
        const automated = isReadonlyAutomationSession(context.sessionKey);
        if (contextAllowsMutation(editEnabled, context)) return;
        const reason = automated
          ? "Automated sessions are read-only."
          : "This conversation is in View mode. Switch it to Edit before requesting changes.";
        return {
          block: true,
          blockReason: `${reason} Mutation and generic execution tools are unavailable.`,
        };
      },
    });
  },
});
