// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  clearRunAccess,
  configureIdentityApprovalBroker,
  configureMcpToolPolicies,
  contextAllowsMutation,
  contextSkipsApproval,
  isReadonlyAutomationSession,
  requestIdentityApproval,
  sessionAccessExtension,
  setRunAccess,
  toolAccess,
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
    const hitl = pluginConfig.hitl !== false;
    const approvalTimeoutMs = typeof pluginConfig.approvalTimeoutMs === "number"
      ? pluginConfig.approvalTimeoutMs
      : 120_000;
    configureMcpToolPolicies(pluginConfig.mcpToolPolicies);
    const mcpConnectionRequestUrl = typeof pluginConfig.mcpConnectionRequestUrl === "string"
      ? pluginConfig.mcpConnectionRequestUrl.endsWith("/")
        ? pluginConfig.mcpConnectionRequestUrl.slice(0, -1)
        : pluginConfig.mcpConnectionRequestUrl
      : "";
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
      async evaluate(event, context) {
        let mutating = false;
        let access = "unknown";
        try {
          access = toolAccess(event.toolName, event.params);
          mutating = toolRequiresEdit(event.toolName, event.params);
        } catch {
          mutating = true;
        }
        if (!mutating) return;
        const automated = isReadonlyAutomationSession(context.sessionKey);
        if (automated || !contextAllowsMutation(editEnabled, context)) return {
          block: true,
          blockReason: automated
            ? "Automated sessions are read-only. Mutation and generic execution tools are unavailable."
            : "This conversation is in View mode. Switch it to Edit before requesting changes. Mutation and generic execution tools are unavailable.",
        };
        if (access !== "unknown" || !hitl || contextSkipsApproval(context)) return;
        const approval = {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          title: "Unclassified tool",
          description: `Allow ${event.toolName || "this unclassified tool"} for this request?`.slice(0, 256),
          severity: "critical" as const,
          timeoutMs: approvalTimeoutMs,
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
      },
    });
    if (editEnabled && mcpConnectionRequestUrl) api.registerTool({
      name: "request_mcp_connection",
      label: "MCP connection",
      description: "Open the generic MCP connection prompt when the operator asks to add or connect an MCP server. Supply the server name and any remote endpoint already known. The operator can enter credentials without adding them to chat, and this call waits until connection and tool discovery finish.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string", description: "Short service name shown to the operator." },
          url: { type: "string", description: "HTTPS MCP endpoint, if known." },
        },
      },
      async execute(toolCallId: string, params: Record<string, unknown>) {
        const token = process.env.OPENCLAW_GATEWAY_TOKEN || "";
        if (!token) return { content: [{ type: "text", text: "MCP connection requests are unavailable." }], isError: true };
        const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
        const created = await fetch(mcpConnectionRequestUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            id: toolCallId,
            name: typeof params.name === "string" ? params.name : "MCP server",
            url: typeof params.url === "string" ? params.url : "",
          }),
        });
        if (!created.ok) return { content: [{ type: "text", text: `Could not open the secure connection prompt (${created.status}).` }], isError: true };
        const deadline = Date.now() + 300_000;
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 750));
          const response = await fetch(`${mcpConnectionRequestUrl}/${encodeURIComponent(toolCallId)}`, { headers });
          if (!response.ok) continue;
          const request = await response.json() as Record<string, unknown>;
          if (request.status === "pending") continue;
          if (request.status === "error") {
            return { content: [{ type: "text", text: typeof request.error === "string" ? request.error : "MCP connection failed." }], isError: true };
          }
          const connection = request.connection as { name?: unknown; tools?: unknown } | undefined;
          const tools = Array.isArray(connection?.tools) ? connection.tools.filter(tool => typeof tool === "string") : [];
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ connected: true, name: connection?.name, toolCount: tools.length, tools }),
            }],
          };
        }
        return { content: [{ type: "text", text: "The secure connection prompt timed out." }], isError: true };
      },
    });
  },
});
