// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  isReadonlyAutomationSession,
  contextSkipsApproval,
  requestIdentityApproval,
  sessionAccessExtension,
} from "../automation-context.ts";
import { runMutationOnce } from "../mutation-ledger.ts";

const DEFAULT_MCP_URL = "http://bcm-mcp-tools:3001/mcp";
const DEFAULT_BCM_HEAD_HOST = "";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_EVENT_CHARS = 4000;
const BCM_CACHE_TTL_MS = 60_000;

const bcmCache = new Map<string, { expiresAt: number; value: unknown }>();
const bcmInFlight = new Map<string, Promise<unknown>>();

type BcmConfig = {
  mcpUrl: string;
  authToken?: string;
  headHost: string;
  mcpMode: string;
  cmshEnabled: boolean;
  editEnabled: boolean;
  hitl: boolean;
  approvalTimeoutMs: number;
  slurmEnabled: boolean;
  timeoutMs: number;
  subagentEventsUrl: string;
};

type SubagentPhase = "start" | "delta" | "complete" | "error";

type SubagentOptions = {
  toolCallId: string;
  toolName: string;
  title: string;
  subagentEventsUrl?: string;
};

function stringConfig(pluginConfig: unknown, key: string) {
  if (!pluginConfig || typeof pluginConfig !== "object") {
    return "";
  }
  const value = (pluginConfig as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function numberConfig(pluginConfig: unknown, key: string, fallback: number) {
  if (!pluginConfig || typeof pluginConfig !== "object") {
    return fallback;
  }
  const value = (pluginConfig as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function boolConfig(pluginConfig: unknown, key: string, fallback: boolean) {
  if (!pluginConfig || typeof pluginConfig !== "object") {
    return fallback;
  }
  const value = (pluginConfig as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : fallback;
}

function envBool(name: string, fallback: boolean) {
  if (typeof process === "undefined" || !process.env) {
    return fallback;
  }
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value);
}

function stringArrayConfig(pluginConfig: unknown, key: string) {
  if (!pluginConfig || typeof pluginConfig !== "object") {
    return [];
  }
  const raw = (pluginConfig as Record<string, unknown>)[key];
  return Array.isArray(raw)
    ? raw.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)
    : [];
}

function isToolEnabled(pluginConfig: unknown, name: string) {
  const enabledTools = new Set(stringArrayConfig(pluginConfig, "enabledTools"));
  if (enabledTools.size > 0 && !enabledTools.has(name)) {
    return false;
  }
  return !new Set(stringArrayConfig(pluginConfig, "disabledTools")).has(name);
}

function normalizeMcpUrl(value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return DEFAULT_MCP_URL;
  }
  return trimmed.endsWith("/mcp") ? trimmed : `${trimmed}/mcp`;
}

function resolveSubagentEventsUrl(pluginConfig: unknown): string {
  const configured = stringConfig(pluginConfig, "subagentEventsUrl");
  if (configured) {
    return configured;
  }
  return "http://mosaic-ui:3000/api/subagents/events";
}

function readConfig(pluginConfig: unknown): BcmConfig {
  const configuredUrl =
    stringConfig(pluginConfig, "mcpUrl") ||
    stringConfig(pluginConfig, "baseUrl") ||
    (typeof process !== "undefined"
      ? process.env?.MOSAIC_BCM_MCP_URL || process.env?.BCM_MCP_URL || ""
      : "");
  const configuredToken =
    stringConfig(pluginConfig, "authToken") ||
    stringConfig(pluginConfig, "token") ||
    (typeof process !== "undefined"
      ? process.env?.MOSAIC_BCM_MCP_TOKEN || process.env?.BCM_MCP_TOKEN || ""
      : "");
  const allowInsecureTls =
    pluginConfig &&
    typeof pluginConfig === "object" &&
    (pluginConfig as Record<string, unknown>).allowInsecureTls === true;
  if (allowInsecureTls && typeof process !== "undefined" && process.env) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  return {
    mcpUrl: normalizeMcpUrl(configuredUrl || DEFAULT_MCP_URL),
    authToken: configuredToken || undefined,
    headHost:
      stringConfig(pluginConfig, "headHost") ||
      (typeof process !== "undefined" ? process.env?.MOSAIC_BCM_HEAD_HOST || process.env?.BCM_HEAD_HOST || "" : "") ||
      DEFAULT_BCM_HEAD_HOST,
    mcpMode:
      stringConfig(pluginConfig, "mcpMode") ||
      (typeof process !== "undefined" ? process.env?.MOSAIC_BCM_MCP_MODE || process.env?.BCM_MCP_MODE || "" : "") ||
      "direct",
    cmshEnabled: boolConfig(pluginConfig, "cmshEnabled", envBool("MOSAIC_BCM_CMSH_ENABLED", true)),
    editEnabled: boolConfig(pluginConfig, "editEnabled", false),
    hitl: boolConfig(pluginConfig, "hitl", true),
    approvalTimeoutMs: numberConfig(pluginConfig, "approvalTimeoutMs", 120_000),
    slurmEnabled: boolConfig(pluginConfig, "slurmEnabled", false),
    timeoutMs: numberConfig(pluginConfig, "timeoutMs", DEFAULT_TIMEOUT_MS),
    subagentEventsUrl: resolveSubagentEventsUrl(pluginConfig),
  };
}

function truncate(value: string, maxChars = MAX_EVENT_CHARS) {
  return value.length > maxChars ? `${value.slice(0, maxChars).trim()}\n...(truncated)` : value;
}

function cmshCommands(value: unknown) {
  if (typeof value !== "string" || !value.trim()) throw new Error("commands is required");
  if (value.length > 4096 || value.includes("\0")) throw new Error("commands must not exceed 4096 characters");
  return value.replace(/\r\n?/g, "\n").trim();
}

function textFromResult(result: unknown) {
  if (!result || typeof result !== "object" || !Array.isArray((result as { content?: unknown }).content)) {
    return "";
  }
  return ((result as { content: unknown[] }).content)
    .map((item) => {
      if (item && typeof item === "object" && "text" in item) {
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function toOpenClawResult(mcpResult: unknown) {
  if (
    mcpResult &&
    typeof mcpResult === "object" &&
    Array.isArray((mcpResult as { content?: unknown }).content)
  ) {
    const result = mcpResult as { content: unknown[]; isError?: boolean };
    if (result.isError) {
      throw new Error(textFromResult(result) || "BCM MCP tool returned isError");
    }
    return { content: result.content, details: mcpResult };
  }

  const text = typeof mcpResult === "string" ? mcpResult : JSON.stringify(mcpResult, null, 2);
  return { content: [{ type: "text", text }], details: mcpResult };
}

function jsonToolResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function parseDeviceStatusRows(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => line.match(/^(HeadNode|PhysicalNode)\s+(\S+)\s+\S+\s+(.*?)\s+(\d+\.\d+\.\d+\.\d+)\s+(\S+)\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({
      type: match[1],
      hostname: match[2],
      category: match[3].trim(),
      ip: match[4],
      network: match[5],
      status: match[6].replace(/\s+/g, " ").trim(),
    }));
}

async function nodeHealthSummary(config: BcmConfig, options: SubagentOptions) {
  postSubagentEvent(options, "start", "Running read-only BCM CMSH command: device; status");
  const startedAt = Date.now();
  try {
    const result = await cachedBcmRpc(
      config,
      "tools/call",
      { name: "execute_cmsh", arguments: bcmToolArgs(config, { commands: "device; status" }) },
    );
    const raw = textFromResult(result);
    const rows = parseDeviceStatusRows(raw);
    postSubagentEvent(options, "complete", `Parsed ${rows.length} BCM node status rows in ${Math.max(1, Math.round((Date.now() - startedAt) / 1000))}s.`);
    return jsonToolResult({
      command: "device; status",
      rows,
      guidance: "Use these rows directly to answer health-check summary requests. Do not run more BCM tools for this summary unless the user asks for deeper RCA on a specific node.",
      raw: truncate(raw, 8000),
    });
  } catch (error) {
    postSubagentEvent(options, "error", `BCM node health summary failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

async function runCmsh(config: BcmConfig, commands: string) {
  const result = await cachedBcmRpc(
    config,
    "tools/call",
    { name: "execute_cmsh", arguments: bcmToolArgs(config, { commands }) },
    180_000,
  );
  if (result && typeof result === "object" && (result as { isError?: boolean }).isError) {
    throw new Error(textFromResult(result) || `CMSH failed: ${commands}`);
  }
  return truncate(textFromResult(result), 20_000);
}

async function slurmJobEvidence(config: BcmConfig, jobId: string, options: SubagentOptions) {
  postSubagentEvent(options, "start", `Reading BCM WLM evidence for Slurm job ${jobId}.`);
  const result = await cachedBcmRpc(
    config,
    "tools/call",
    { name: "slurm_job_evidence", arguments: bcmToolArgs(config, { job_id: jobId }) },
    180_000,
  );
  postSubagentEvent(options, "complete", `Collected BCM WLM metadata, stdout, and stderr for job ${jobId}.`);
  return jsonToolResult({ backend: "bcm-wlm", jobId, evidence: textFromResult(result) });
}

function compactToolSummaries(tools: unknown[]) {
  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object") {
        return null;
      }
      const candidate = tool as Record<string, unknown>;
      const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
      if (!name) {
        return null;
      }
      const description =
        typeof candidate.description === "string"
          ? candidate.description
              .split(/\r?\n/)
              .map((line) => line.trim())
              .find(Boolean) || ""
          : "";
      return description ? { name, description: truncate(description, 180) } : { name };
    })
    .filter(Boolean);
}

function bcmToolArgs(config: BcmConfig, args: Record<string, unknown>) {
  return config.mcpMode === "ssh-adapter" ? { hostname: config.headHost, ...args } : args;
}

function postSubagentEvent(options: SubagentOptions, phase: SubagentPhase, content: string) {
  if (!options.subagentEventsUrl) {
    return;
  }

  const payload = {
    id: `${options.toolCallId}-${phase}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    source: "bcm",
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    title: options.title,
    phase,
    status: phase === "complete" ? "complete" : phase === "error" ? "error" : "running",
    content: truncate(content),
    timestamp: new Date().toISOString(),
  };

  void fetch(options.subagentEventsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Subagent UI telemetry is best-effort and must not fail BCM execution.
  });
}

function sseDataBlocks(text: string) {
  const blocks: string[] = [];
  const normalized = text.replace(/\r\n?/g, "\n");
  for (const rawEvent of normalized.split("\n\n")) {
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith(":")) {
        continue;
      }
      if (line.startsWith("data:")) {
        const value = line.slice(5);
        dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
      }
    }
    const data = dataLines.join("\n").trim();
    if (data) {
      blocks.push(data);
    }
  }
  return blocks;
}

function parseRpcPayload(responseText: string): Record<string, unknown> {
  const ssePayloads = sseDataBlocks(responseText);
  for (const data of ssePayloads) {
    try {
      const parsed = JSON.parse(data) as unknown;
      if (parsed && typeof parsed === "object" && ("result" in parsed || "error" in parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next SSE data block.
    }
  }

  const parsed = JSON.parse(responseText) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("BCM MCP returned a non-object JSON-RPC payload");
  }
  return parsed as Record<string, unknown>;
}

function errorMessageFromRpc(error: unknown) {
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
    return JSON.stringify(error);
  }
  return String(error);
}

function normalizeRpcValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/[;\s]+/g, " ").trim();
  }
  if (Array.isArray(value)) {
    return value.map(normalizeRpcValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalizeRpcValue(item)]),
    );
  }
  return value;
}

function cachedRpcKey(method: string, params: Record<string, unknown>) {
  return JSON.stringify({ method, params: normalizeRpcValue(params) });
}

async function bcmRpc(
  config: BcmConfig,
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? config.timeoutMs);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (config.authToken) {
    headers.Authorization = `Bearer ${config.authToken}`;
  }

  try {
    const response = await fetch(config.mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        method,
        params,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`BCM MCP ${method} failed (${response.status}): ${truncate(text, 1200)}`);
    }
    const payload = parseRpcPayload(text);
    if ("error" in payload) {
      throw new Error(`BCM MCP ${method} error: ${errorMessageFromRpc(payload.error)}`);
    }
    if (!("result" in payload)) {
      throw new Error(`BCM MCP ${method} returned no result`);
    }
    return payload.result;
  } finally {
    clearTimeout(timer);
  }
}

async function cachedBcmRpc(
  config: BcmConfig,
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<unknown> {
  const key = cachedRpcKey(method, params);
  const cached = bcmCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const active = bcmInFlight.get(key);
  if (active) {
    return active;
  }
  const request = bcmRpc(config, method, params, timeoutMs)
    .then((value) => {
      bcmCache.set(key, { value, expiresAt: Date.now() + BCM_CACHE_TTL_MS });
      return value;
    })
    .finally(() => bcmInFlight.delete(key));
  bcmInFlight.set(key, request);
  return request;
}

function compactArgs(args: Record<string, unknown>) {
  const text = JSON.stringify(args, null, 2);
  return truncate(text, 1000);
}

function summarizeResult(toolName: string, result: unknown, elapsedMs: number) {
  const elapsed = Math.max(1, Math.round(elapsedMs / 1000));
  const text = textFromResult(result);
  if (!text) {
    return `BCM MCP tool ${toolName} completed in ${elapsed}s.`;
  }
  return `BCM MCP tool ${toolName} completed in ${elapsed}s.\n\n${truncate(text, 2600)}`;
}

async function callBcmTool(
  config: BcmConfig,
  mcpToolName: string,
  args: Record<string, unknown>,
  options: SubagentOptions,
) {
  postSubagentEvent(
    options,
    "start",
    [
      `Opening BCM MCP/SSE endpoint: ${config.mcpUrl}`,
      `Calling MCP tool: ${mcpToolName}`,
      `Arguments: ${compactArgs(args)}`,
    ].join("\n"),
  );
  const startedAt = Date.now();
  try {
    postSubagentEvent(options, "delta", "BCM MCP request is in flight.");
    const result = await cachedBcmRpc(config, "tools/call", { name: mcpToolName, arguments: args });
    postSubagentEvent(options, "complete", summarizeResult(mcpToolName, result, Date.now() - startedAt));
    return toOpenClawResult(result);
  } catch (error) {
    postSubagentEvent(
      options,
      "error",
      `BCM MCP tool ${mcpToolName} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

function stringParam(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function numberParam(value: unknown, fallback: number, min = 1, max = 500) {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function objectParam(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringArrayParam(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
    : [];
}

function mergeLoadedModule(context: Record<string, unknown>, moduleName: string) {
  const modules = new Set(stringArrayParam(context.loaded_modules));
  modules.add(moduleName);
  context.loaded_modules = [...modules];
}

function defaultExecutionContext(config: BcmConfig, toolId: string, rawContext?: Record<string, unknown>) {
  const context = rawContext ? { ...rawContext } : {};
  if (!stringParam(context.ssh_host) && config.headHost) {
    context.ssh_host = config.headHost;
  }
  if (toolId.startsWith("kubernetes.")) {
    mergeLoadedModule(context, "kubernetes");
  }
  if (toolId.startsWith("slurm.")) {
    mergeLoadedModule(context, "slurm");
  }
  return context;
}

function subagentOptions(
  config: BcmConfig,
  toolCallId: string,
  toolName: string,
  title = "BCM MCP",
): SubagentOptions {
  return {
    toolCallId,
    toolName,
    title,
    subagentEventsUrl: config.subagentEventsUrl,
  };
}

export default definePluginEntry({
  id: "bcm",
  name: "BCM MCP Plugin",
  description: "MCP streamable HTTP/SSE bridge from OpenClaw to bcm-mcp-tools diagnostics.",
  register(api) {
    const config = readConfig(api.pluginConfig);
    api.session.state.registerSessionExtension(sessionAccessExtension);
    const registerTool = (tool: Parameters<typeof api.registerTool>[0]) => {
      if (isToolEnabled(api.pluginConfig, tool.name)) {
        api.registerTool(tool);
      }
    };

    api.registerTrustedToolPolicy({
      id: "bcm-access",
      description: "Blocks automated BCM mutations and requires approval in Edit mode.",
      async evaluate(event, context) {
        const automated = isReadonlyAutomationSession(context.sessionKey);
        if (automated && ["bcm_add_note", "bcm_execute_cmsh_admin", "bcm_remove_note"].includes(event.toolName)) {
          return {
            block: true,
            blockReason: "Automated Mosaic sessions cannot use BCM mutation tools.",
          };
        }
        const mutating = ["bcm_add_note", "bcm_execute_cmsh_admin", "bcm_remove_note"].includes(event.toolName);
        if (!mutating) return;
        try {
          const commands = event.toolName === "bcm_execute_cmsh_admin"
            ? cmshCommands(event.params.commands)
            : undefined;
          if (!config.hitl || contextSkipsApproval(context)) return;
          const noteAction = event.toolName === "bcm_add_note" ? "Add BCM investigation note" : "Remove BCM investigation note";
          const approval = {
            title: event.toolName === "bcm_execute_cmsh_admin" ? "BCM CMSH change" : noteAction,
            description: commands ? `${commands} on BCM head ${config.headHost}`.slice(0, 256) : noteAction,
            severity: "critical" as const,
            timeoutMs: config.approvalTimeoutMs,
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
        } catch (error) {
          return {
            block: true,
            blockReason: error instanceof Error ? error.message : "CMSH request was rejected",
          };
        }
      },
    });

    registerTool({
      name: "bcm_health",
      label: "BCM MCP Health",
      description: "Check whether the configured bcm-mcp-tools MCP endpoint is reachable and list exposed MCP tools.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute(toolCallId: string) {
        const options = subagentOptions(config, toolCallId, "bcm_health", "BCM MCP health");
        postSubagentEvent(options, "start", `Checking BCM MCP endpoint: ${config.mcpUrl}`);
        try {
          const toolsResult = await cachedBcmRpc(config, "tools/list", {}, 30_000);
          const tools = Array.isArray((toolsResult as { tools?: unknown }).tools)
            ? ((toolsResult as { tools: unknown[] }).tools)
            : [];
          const toolSummaries = compactToolSummaries(tools);
          postSubagentEvent(
            options,
            "complete",
            `BCM MCP is reachable. Exposed MCP tools: ${tools.length}.`,
          );
          return jsonToolResult({
            mcpUrl: config.mcpUrl,
            reachable: true,
            toolCount: tools.length,
            tools: toolSummaries,
          });
        } catch (error) {
          postSubagentEvent(options, "error", `BCM MCP health failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
      },
    });

    registerTool({
      name: "bcm_get_info",
      label: "BCM Get Info",
      description: "Return BCM cluster and host information by calling bcm.get_info through bcm-mcp-tools.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute(toolCallId: string) {
        const context = defaultExecutionContext(config, "bcm.get_info");
        return callBcmTool(
          config,
          "execute_tool",
          bcmToolArgs(config, {
            tool_id: "bcm.get_info",
            ...(Object.keys(context).length ? { context } : {}),
          }),
          subagentOptions(config, toolCallId, "bcm_get_info", "BCM cluster info"),
        );
      },
    });

    if (config.slurmEnabled && config.cmshEnabled) registerTool({
      name: "slurm_job_evidence",
      label: "Slurm Job Evidence",
      description: "Return read-only BCM WLM metadata, stdout, and stderr for a numeric Slurm job id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["jobId"],
        properties: {
          jobId: { type: "string", pattern: "^[0-9]+$", description: "Numeric Slurm job id." },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const jobId = stringParam(rawParams.jobId);
        if (!/^[0-9]+$/.test(jobId)) {
          throw new Error("jobId must be numeric");
        }
        return slurmJobEvidence(
          config,
          jobId,
          subagentOptions(config, toolCallId, "slurm_job_evidence", "Slurm job evidence"),
        );
      },
    });

    if (config.cmshEnabled) registerTool({
      name: "bcm_node_health_summary",
      label: "BCM Node Health Summary",
      description: "Return parsed current BCM node health-check status using the read-only CMSH command device; status. Use this as the only tool for node health tables.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute(toolCallId: string) {
        return nodeHealthSummary(config, subagentOptions(config, toolCallId, "bcm_node_health_summary", "BCM node health"));
      },
    });

    registerTool({
      name: "bcm_search_tools",
      label: "BCM Search Tools",
      description: "Search bcm-mcp-tools diagnostic tool IDs and descriptions before choosing a BCM command to run.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "Tool search query. Empty returns all tool IDs." },
          limit: { type: "number", description: "Maximum tools to return." },
          regex: { type: "boolean", description: "Treat query as a case-insensitive regular expression." },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const query = stringParam(rawParams.query);
        return callBcmTool(
          config,
          "search_tool",
          {
            ...bcmToolArgs(config, {}),
            query,
            limit: numberParam(rawParams.limit, 25, 1, 250),
            regex: rawParams.regex === true,
          },
          subagentOptions(config, toolCallId, "bcm_search_tools", "BCM tool search"),
        );
      },
    });

    registerTool({
      name: "bcm_execute_tool",
      label: "BCM Execute Tool",
      description:
        "Execute a read-only bcm-mcp-tools diagnostic command by tool_id. Use bcm_search_tools first when the exact tool_id is unknown.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["tool_id"],
        properties: {
          tool_id: { type: "string", description: "BCM MCP registry tool ID, for example system.uname, bcm.get_info, or kubernetes.kubectl_get." },
          tool_kwargs: { type: "object", additionalProperties: true, description: "Tool-specific arguments." },
          context: { type: "object", additionalProperties: true, description: "Optional execution context such as ssh_host, pdsh, chroot_path, or loaded_modules." },
          filter_options: { type: "object", additionalProperties: true, description: "Optional grep/sort/slice filters applied by bcm-mcp-tools." },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const toolId = stringParam(rawParams.tool_id);
        if (!toolId) {
          throw new Error("tool_id is required");
        }
        const args: Record<string, unknown> = { tool_id: toolId };
        const toolKwargs = objectParam(rawParams.tool_kwargs);
        const context = defaultExecutionContext(config, toolId, objectParam(rawParams.context));
        const filterOptions = objectParam(rawParams.filter_options);
        if (toolKwargs) args.tool_kwargs = toolKwargs;
        args.context = context;
        if (filterOptions) args.filter_options = filterOptions;
        return callBcmTool(
          config,
          "execute_tool",
          bcmToolArgs(config, args),
          subagentOptions(config, toolCallId, "bcm_execute_tool", `BCM ${toolId}`),
        );
      },
    });

    if (config.cmshEnabled) registerTool({
      name: "bcm_execute_cmsh",
      label: "BCM Execute CMSH",
      description: "Execute CMSH through the BCM readonly identity. This tool never uses admin access and never requests approval. Use cmsh -c style semicolon-separated commands.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["commands"],
        properties: {
          commands: { type: "string", description: "CMSH commands in cmsh -c style, for example device; list." },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        return callBcmTool(
          config,
          "execute_cmsh",
          bcmToolArgs(config, { commands: cmshCommands(rawParams.commands) }),
          subagentOptions(config, toolCallId, "bcm_execute_cmsh", "BCM CMSH"),
        );
      },
    });

    if (config.editEnabled && config.cmshEnabled) registerTool({
      name: "bcm_execute_cmsh_admin",
      label: "BCM Execute CMSH Admin",
      description: "Execute one CMSH request through the configured BCM admin identity. This tool always uses edit capability and may require approval. Use bcm_execute_cmsh for every readonly request.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["commands"],
        properties: {
          commands: { type: "string", description: "Exact CMSH command body in cmsh -c semicolon-separated form." },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const commands = cmshCommands(rawParams.commands);
        const execute = () => callBcmTool(
          config,
          "execute_cmsh_admin",
          bcmToolArgs(config, { commands }),
          subagentOptions(config, toolCallId, "bcm_execute_cmsh_admin", "BCM CMSH admin"),
        );
        const attempt = await runMutationOnce({
          toolCallId,
          toolName: "bcm_execute_cmsh_admin",
          target: config.headHost,
          args: commands,
        }, execute);
        return attempt.replayed
          ? jsonToolResult({
              replayed: true,
              executed: false,
              idempotencyKey: toolCallId,
              previousStatus: attempt.state,
            })
          : attempt.result;
      },
    });

    registerTool({
      name: "bcm_list_notes",
      label: "BCM List Notes",
      description: "List BCM cluster notes maintained by bcm-mcp-tools.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute(toolCallId: string) {
        return callBcmTool(config, "list_notes", bcmToolArgs(config, {}), subagentOptions(config, toolCallId, "bcm_list_notes", "BCM notes"));
      },
    });

    registerTool({
      name: "bcm_search_notes",
      label: "BCM Search Notes",
      description: "Search BCM cluster notes for prior investigations, known issues, and local operating context.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "Notes search query." },
          limit: { type: "number", description: "Maximum notes to return." },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const query = stringParam(rawParams.query);
        if (!query) {
          throw new Error("query is required");
        }
        return callBcmTool(
          config,
          "search_notes",
          bcmToolArgs(config, { query, limit: numberParam(rawParams.limit, 5, 1, 50) }),
          subagentOptions(config, toolCallId, "bcm_search_notes", "BCM notes search"),
        );
      },
    });

    registerTool({
      name: "bcm_add_note",
      label: "BCM Add Note",
      description: "Save a BCM investigation note for future sessions.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["subject", "content"],
        properties: {
          subject: { type: "string", description: "Brief note subject." },
          content: { type: "string", description: "Markdown note content." },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const subject = stringParam(rawParams.subject);
        const content = stringParam(rawParams.content);
        if (!subject || !content) {
          throw new Error("subject and content are required");
        }
        return callBcmTool(
          config,
          "add_note",
          bcmToolArgs(config, { subject, content }),
          subagentOptions(config, toolCallId, "bcm_add_note", "BCM note write"),
        );
      },
    });

    registerTool({
      name: "bcm_remove_note",
      label: "BCM Remove Note",
      description: "Remove an outdated BCM note by filename. Use only when the user asks to delete or replace a note.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["filename"],
        properties: {
          filename: { type: "string", description: "Note filename to remove." },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const filename = stringParam(rawParams.filename);
        if (!filename) {
          throw new Error("filename is required");
        }
        return callBcmTool(
          config,
          "remove_note",
          bcmToolArgs(config, { filename }),
          subagentOptions(config, toolCallId, "bcm_remove_note", "BCM note delete"),
        );
      },
    });

    registerTool({
      name: "bcm_search_docs",
      label: "BCM Search Docs",
      description: "Search local BCM documentation indexed by bcm-mcp-tools, when that optional server feature is enabled.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "BCM documentation search query." },
          limit: { type: "number", description: "Maximum documentation matches to return." },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const query = stringParam(rawParams.query);
        if (!query) {
          throw new Error("query is required");
        }
        return callBcmTool(
          config,
          "search_bcm_docs",
          bcmToolArgs(config, { query, limit: numberParam(rawParams.limit, 3, 1, 20) }),
          subagentOptions(config, toolCallId, "bcm_search_docs", "BCM docs search"),
        );
      },
    });
  },
});
