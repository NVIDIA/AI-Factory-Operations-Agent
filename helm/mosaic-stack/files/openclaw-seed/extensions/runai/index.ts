// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { callRunaiTool, listRunaiTools, type RunaiConfig } from "./client.ts";

function config(pluginConfig: unknown): RunaiConfig {
  const raw = (pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {}) as Record<string, unknown>;
  const required = (name: string, fallback = "") => {
    const value = typeof raw[name] === "string" ? raw[name].trim() : fallback;
    if (!value || value.startsWith("${")) throw new Error(`Run:ai ${name} is required`);
    return value;
  };
  return {
    baseUrl: required("baseUrl"),
    mcpUrl: required("mcpUrl", "http://runai-mcp:8080/mcp"),
    clientId: required("clientId"),
    clientSecret: required("clientSecret"),
    timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : 60_000,
  };
}

function result(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], details: payload };
}

export default definePluginEntry({
  id: "runai",
  name: "Run:ai MCP",
  description: "Read-only bridge to the NVIDIA Run:ai MCP server.",
  register(api) {
    const settings = config(api.pluginConfig);
    api.registerTool({
      name: "runai_list_tools",
      label: "Run:ai List Tools",
      description: "List the read-only tools currently exposed by the configured NVIDIA Run:ai MCP server, including their input schemas.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        return result(await listRunaiTools(settings));
      },
    });
    api.registerTool({
      name: "runai_call_tool",
      label: "Run:ai Call Tool",
      description: "Call a tool returned by runai_list_tools. Match its input schema exactly and omit optional arguments instead of guessing values. The bridge rejects tools that the upstream MCP server does not mark read-only.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string", description: "Exact Run:ai MCP tool name returned by runai_list_tools." },
          arguments: { type: "object", description: "Arguments matching that tool's input schema." },
        },
      },
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        const name = typeof params.name === "string" ? params.name.trim() : "";
        if (!name) throw new Error("name is required");
        const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
          ? params.arguments as Record<string, unknown>
          : {};
        return result(await callRunaiTool(settings, name, args));
      },
    });
  },
});
