#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import readline from "node:readline";

const baseUrl = process.env.MOSAIC_URL || "http://127.0.0.1:3000";
const builtinTools = [
  {
    name: "ai_factory_operations_agent_chat",
    description: "Investigate or operate using configured agents.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        sessionKey: { type: "string" },
        timeoutMs: { type: "number" },
        conciseMode: { type: "boolean" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "ai_factory_operations_agent_history",
    description: "Read conversation history.",
    inputSchema: {
      type: "object",
      properties: { sessionKey: { type: "string" }, limit: { type: "number" } },
    },
  },
  {
    name: "ai_factory_operations_agent_commands",
    description: "List slash commands and agent entrypoints.",
    inputSchema: { type: "object", properties: {} },
  },
];

let toolCache;

async function request(path, init) {
  const response = await fetch(new URL(path, baseUrl), init);
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { text }; }
  if (!response.ok) throw new Error(payload.message || payload.error || text || response.statusText);
  return payload;
}

async function listTools() {
  if (toolCache) return toolCache;
  let moduleTools = [];
  try {
    const catalog = await request("/api/openclaw/tools");
    moduleTools = Array.isArray(catalog.tools) ? catalog.tools.map(tool => ({
      name: tool.name,
      description: tool.description || `Call tool ${tool.name}.`,
      inputSchema: tool.inputSchema || { type: "object", additionalProperties: true },
    })).filter(tool => typeof tool.name === "string" && tool.name) : [];
  } catch {}
  const builtinNames = new Set(builtinTools.map(tool => tool.name));
  toolCache = [...builtinTools, ...moduleTools.filter(tool => !builtinNames.has(tool.name))];
  return toolCache;
}

async function callTool(name, args = {}) {
  if (name === "ai_factory_operations_agent_chat") {
    const payload = await request("/api/headless/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    return payload.message || JSON.stringify(payload);
  }
  if (name === "ai_factory_operations_agent_history") {
    const params = new URLSearchParams({
      sessionKey: typeof args.sessionKey === "string" ? args.sessionKey : "headless",
      limit: String(Number.isFinite(args.limit) ? args.limit : 24),
    });
    return JSON.stringify(await request(`/api/openclaw/chat?${params}`), null, 2);
  }
  if (name === "ai_factory_operations_agent_commands") {
    return JSON.stringify(await request("/api/openclaw/commands"), null, 2);
  }
  const payload = await request("/api/openclaw/tools/call", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args, sessionKey: args.sessionKey || "headless" }),
  });
  return typeof payload.result === "string"
    ? payload.result
    : JSON.stringify(payload.result ?? payload, null, 2);
}

function respond(id, result, error) {
  const payload = error
    ? { jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

readline.createInterface({ input: process.stdin }).on("line", async line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!message || typeof message !== "object" || message.id === undefined) return;
  try {
    if (message.method === "initialize") {
      respond(message.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ai_factory_operations_agent", version: "0.1.0" },
      });
    } else if (message.method === "tools/list") {
      respond(message.id, { tools: await listTools() });
    } else if (message.method === "tools/call") {
      const text = await callTool(message.params?.name, message.params?.arguments || {});
      respond(message.id, { content: [{ type: "text", text }] });
    } else {
      respond(message.id, {});
    }
  } catch (error) {
    respond(message.id, null, error);
  }
});
