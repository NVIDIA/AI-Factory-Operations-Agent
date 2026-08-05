// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_BASE_URL = "http://diagnostic-agent";
const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_DGX_BASEBOARD = "Blackwell-HGX-8-GPU";
const MAX_EVENT_CHARS = 4000;

type DiagnosticConfig = {
  baseUrl: string;
  apiKey?: string;
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

function normalizeBaseUrl(value: string) {
  return (value || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
}

function resolveSubagentEventsUrl(pluginConfig: unknown): string {
  const configured = stringConfig(pluginConfig, "subagentEventsUrl");
  if (configured) {
    return configured;
  }
  return "http://mosaic-ui:3000/api/subagents/events";
}

function firstApiKey(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") {
      return parsed.trim();
    }
    const values = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? Object.values(parsed) : [];
    const first = values.find((entry) => typeof entry === "string" && entry.trim());
    return typeof first === "string" ? first.trim() : "";
  } catch {
    return trimmed.split(/[,\n]/).map((entry) => entry.trim()).find(Boolean) || trimmed;
  }
}

function readConfig(pluginConfig: unknown): DiagnosticConfig {
  const configuredUrl =
    stringConfig(pluginConfig, "baseUrl") ||
    (typeof process !== "undefined"
      ? process.env?.MOSAIC_DIAGNOSTIC_AGENT_URL || process.env?.DIAGNOSTIC_AGENT_URL || ""
      : "");
  const configuredApiKey = firstApiKey(
    stringConfig(pluginConfig, "apiKey") ||
      (typeof process !== "undefined"
        ? process.env?.DIAGNOSTIC_AGENT_API_KEY || process.env?.AGENT_API_KEYS || ""
        : ""),
  );

  return {
    baseUrl: normalizeBaseUrl(configuredUrl || DEFAULT_BASE_URL),
    apiKey: configuredApiKey || undefined,
    timeoutMs: numberConfig(pluginConfig, "timeoutMs", DEFAULT_TIMEOUT_MS),
    subagentEventsUrl: resolveSubagentEventsUrl(pluginConfig),
  };
}

function truncate(value: string, maxChars = MAX_EVENT_CHARS) {
  return value.length > maxChars ? `${value.slice(0, maxChars).trim()}\n...(truncated)` : value;
}

function jsonToolResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function stringParam(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function numberParam(value: unknown, fallback: number, min: number, max: number) {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, parsed));
}

function objectParam(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function inferRecentSessionKey() {
  try {
    const fs = require("fs") as typeof import("fs");
    const home = typeof process !== "undefined" ? process.env?.HOME || "/home/node" : "/home/node";
    const paths = [
      typeof process !== "undefined" ? process.env?.MOSAIC_OPENCLAW_SESSIONS_FILE || "" : "",
      "/home/node/.openclaw/agents/default/sessions/sessions.json",
      `${home}/.openclaw/agents/default/sessions/sessions.json`,
    ].filter(Boolean);

    for (const path of paths) {
      if (!fs.existsSync(path)) {
        continue;
      }
      const data = JSON.parse(fs.readFileSync(path, "utf8"));
      if (!data || typeof data !== "object") {
        continue;
      }
      let bestKey = "";
      let bestUpdatedAt = -1;
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        const session = objectParam(value) || {};
        const sessionKey = stringParam(session.sessionKey) || key;
        if (!sessionKey.startsWith("agent:default:session-")) {
          continue;
        }
        const updatedAt = typeof session.updatedAt === "number" && Number.isFinite(session.updatedAt)
          ? session.updatedAt
          : 0;
        if (updatedAt > bestUpdatedAt) {
          bestUpdatedAt = updatedAt;
          bestKey = sessionKey;
        }
      }
      if (bestKey) {
        return bestKey;
      }
    }
  } catch {
    // Best-effort fallback for UI sessions when the model omits runtime metadata.
  }
  return "";
}

function normalizeDutId(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }
  return value.trim().replace(/^dgx[\s_-]*(\d+)$/i, (_match, id) => `dgx-${id.padStart(2, "0")}`);
}

function applyDutDefaults(dut: Record<string, unknown>) {
  dut.id = normalizeDutId(dut.id);
  if (!stringParam(dut.baseboard) && typeof dut.id === "string" && /^dgx-\d+$/i.test(dut.id)) {
    dut.baseboard = DEFAULT_DGX_BASEBOARD;
  }
}

function compactJson(value: unknown, maxChars = MAX_EVENT_CHARS) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return truncate(text || "", maxChars);
}

function triageSummary(value: unknown) {
  const triage = objectParam(value) || {};
  const request = objectParam(triage.request) || {};
  const dut = objectParam(request.dut) || {};
  const text = (field: unknown, maxChars: number) => typeof field === "string" ? truncate(field, maxChars) : field;
  return {
    triage_id: triage.triage_id,
    status: triage.status,
    dut_id: dut.id,
    event_text: text(request.event_text || triage.event_summary, 500),
    root_cause: text(triage.root_cause, 1000),
    severity: triage.severity,
    confidence: triage.confidence,
    submitted_at: triage.submitted_at,
    completed_at: triage.completed_at,
    error: text(triage.error, 500),
  };
}

function headers(config: DiagnosticConfig) {
  const result: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    result["X-API-Key"] = config.apiKey;
  }
  return result;
}

async function fetchJson(
  config: DiagnosticConfig,
  path: string,
  options: RequestInit = {},
  timeoutMs = config.timeoutMs,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...options,
      headers: {
        ...headers(config),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    if (!response.ok) {
      throw new Error(`Hardware Agent request ${path} failed (${response.status}): ${compactJson(payload, 1000)}`);
    }
    return payload as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

async function postSubagentEvent(options: SubagentOptions, phase: SubagentPhase, content: string) {
  if (!options.subagentEventsUrl) {
    return;
  }

  const payload = {
    id: `${options.toolCallId}-${phase}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    source: "hardware-agent",
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    title: options.title,
    phase,
    status: phase === "complete" ? "complete" : phase === "error" ? "error" : "running",
    content: truncate(content),
    timestamp: new Date().toISOString(),
  };

  await fetch(options.subagentEventsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Subagent UI telemetry is best-effort and must not fail diagnostics.
  });
}

function subagentOptions(
  config: DiagnosticConfig,
  toolCallId: string,
  toolName: string,
  title: string,
): SubagentOptions {
  return {
    toolCallId,
    toolName,
    title,
    subagentEventsUrl: config.subagentEventsUrl,
  };
}

function triageIdFrom(value: unknown) {
  return value && typeof value === "object" && typeof (value as Record<string, unknown>).triage_id === "string"
    ? ((value as Record<string, unknown>).triage_id as string)
    : "";
}

export default definePluginEntry({
  id: "hardware-agent",
  name: "NVDebug Hardware Agent",
  description: "HTTP tool bridge from OpenClaw to the Hardware Agent for NVDebug hardware triage.",
  register(api) {
    const config = readConfig(api.pluginConfig);
    const registerTool = (tool: Parameters<typeof api.registerTool>[0]) => {
      if (isToolEnabled(api.pluginConfig, tool.name)) {
        api.registerTool(tool);
      }
    };

    registerTool({
      name: "hardware_health",
      label: "Hardware Agent Health",
      description: "Check whether the Hardware Agent is reachable and list dependency health.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute(toolCallId: string) {
        const events = subagentOptions(config, toolCallId, "hardware_health", "Hardware Agent");
        await postSubagentEvent(events, "start", `Checking Hardware Agent health at ${config.baseUrl}`);
        try {
          const health = await fetchJson(config, "/api/v1/health", { method: "GET" }, 30_000);
          await postSubagentEvent(events, "complete", compactJson(health));
          return jsonToolResult({ baseUrl: config.baseUrl, health });
        } catch (error) {
          await postSubagentEvent(events, "error", error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    });

    registerTool({
      name: "hardware_triage_list",
      label: "Recent Hardware Triages",
      description: "List recent Hardware Agent triages so existing hardware evidence can be reused before starting a new NVDebug collection.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "number", description: "Maximum recent triages to return. Defaults to 20; maximum 100." },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const limit = Math.round(numberParam(rawParams.limit, 20, 1, 100));
        const events = subagentOptions(config, toolCallId, "hardware_triage_list", "Hardware Agent");
        await postSubagentEvent(events, "start", "Fetching recent Hardware Agent triages");
        try {
          const response = await fetchJson(config, `/api/v1/triages?limit=${limit}`, { method: "GET" }, 60_000);
          const triages = Array.isArray(response) ? response.map(triageSummary) : response;
          await postSubagentEvent(events, "complete", compactJson(triages));
          return jsonToolResult(triages);
        } catch (error) {
          await postSubagentEvent(events, "error", error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    });

    registerTool({
      name: "hardware_analyze_dut",
      label: "NVDebug Analyze DUT",
      description:
        "Start a fresh, long-running NVDebug hardware collection. Before asking for approval, say exactly: 'A fresh NVDebug collection can take 5-30 minutes. Do you want me to start it?' Wait for the next user reply. Interpret an ordinary affirmative response in conversation, then invoke this tool without encoding the user's wording into its arguments. Never demand a formal phrase. For generic hardware questions, use hardware_triage_list first.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["dut"],
        properties: {
          dut: {
            type: "object",
            additionalProperties: true,
            description: "DUTInfo-style object. Provide the hostname as id; the Hardware Agent resolves BMC details and credentials.",
          },
          event_text: {
            type: "string",
            description: "Optional dmesg/log/free-text fault signature. Omit it for a general hardware health collection.",
          },
          profile_name: {
            type: "string",
            description: "Optional nvdebug collection profile override from the matched playbook.",
          },
          ai_factory_operations_agent_chat_session_key: {
            type: "string",
            description: "Optional chat session key. Copy the exact value from the [Runtime Context] block when present so the Hardware Agent can stream NVDebug progress to the matching Terminal tab.",
          },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const dut = objectParam(rawParams.dut);
        if (!dut) {
          throw new Error("dut is required");
        }
        applyDutDefaults(dut);
        const displayDutId = typeof dut.id === "string" ? dut.id : "DUT";
        const eventText = stringParam(rawParams.event_text) ||
          `General hardware health collection requested for ${displayDutId}; no specific fault signature supplied.`;
        const body: Record<string, unknown> = {
          dut,
          event_text: eventText,
        };
        const profileName = stringParam(rawParams.profile_name);
        const chatSessionKey = stringParam(rawParams.ai_factory_operations_agent_chat_session_key) || inferRecentSessionKey();
        if (profileName) body.profile_name = profileName;
        if (chatSessionKey) body.mosaic_chat_session_key = chatSessionKey;

        const events = subagentOptions(config, toolCallId, "hardware_analyze_dut", "Hardware Agent");
        await postSubagentEvent(events, "start", `Submitting NVDebug hardware analysis for ${displayDutId}\n${eventText}`);
        try {
          const submitted = await fetchJson(config, "/api/v1/analyze-dut", {
            method: "POST",
            body: JSON.stringify(body),
          });
          const triageId = triageIdFrom(submitted);
          await postSubagentEvent(events, "complete", `Hardware triage submitted: ${compactJson(submitted)}`);
          return jsonToolResult({ submitted, triage_id: triageId });
        } catch (error) {
          await postSubagentEvent(events, "error", error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    });

    registerTool({
      name: "hardware_triage_status",
      label: "Hardware Triage Status",
      description: "Fetch status/progress for an existing Hardware Agent triage id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["triage_id"],
        properties: {
          triage_id: { type: "string", description: "Hardware triage id returned by hardware_analyze_dut or /api/v1/analyze-dut." },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const triageId = stringParam(rawParams.triage_id);
        if (!triageId) {
          throw new Error("triage_id is required");
        }
        const events = subagentOptions(config, toolCallId, "hardware_triage_status", "Hardware Agent");
        await postSubagentEvent(events, "start", `Fetching hardware status for ${triageId}`);
        try {
          const status = await fetchJson(config, `/api/v1/triage/${encodeURIComponent(triageId)}`, { method: "GET" }, 60_000);
          await postSubagentEvent(events, "complete", compactJson(status));
          return jsonToolResult(status);
        } catch (error) {
          await postSubagentEvent(events, "error", error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    });

    registerTool({
      name: "hardware_triage_report",
      label: "Hardware Triage Report",
      description: "Fetch the full Hardware Agent report for an existing triage id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["triage_id"],
        properties: {
          triage_id: { type: "string", description: "Hardware triage id returned by hardware_analyze_dut or /api/v1/analyze-dut." },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const triageId = stringParam(rawParams.triage_id);
        if (!triageId) {
          throw new Error("triage_id is required");
        }
        const events = subagentOptions(config, toolCallId, "hardware_triage_report", "Hardware Agent");
        await postSubagentEvent(events, "start", `Fetching hardware report for ${triageId}`);
        try {
          const report = await fetchJson(config, `/api/v1/triage/${encodeURIComponent(triageId)}/report`, { method: "GET" }, 120_000);
          await postSubagentEvent(events, "complete", compactJson(report));
          return jsonToolResult(report);
        } catch (error) {
          await postSubagentEvent(events, "error", error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    });
  },
});
