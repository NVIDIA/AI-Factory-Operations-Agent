import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_BASE_URL = "http://diagnostic-agent";
const DEFAULT_TIMEOUT_MS = 1_800_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_DGX_BASEBOARD = "Blackwell-HGX-8-GPU";
const DEFAULT_MOSAIC_PROFILE = "mosaic_h1_only";
const DEFAULT_ANALYZE_ATTEMPTS = 2;
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

function mosaicUiBaseUrlFromEventsUrl(eventsUrl: string) {
  try {
    const url = new URL(eventsUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function readConfig(pluginConfig: unknown): DiagnosticConfig {
  const configuredUrl =
    stringConfig(pluginConfig, "baseUrl") ||
    (typeof process !== "undefined"
      ? process.env?.MOSAIC_DIAGNOSTIC_AGENT_URL || process.env?.DIAGNOSTIC_AGENT_URL || ""
      : "");
  const configuredApiKey =
    stringConfig(pluginConfig, "apiKey") ||
    (typeof process !== "undefined"
      ? process.env?.DIAGNOSTIC_AGENT_API_KEY || ""
      : "");

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

function inferRecentMosaicSessionKey() {
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
    // Best-effort fallback for Mosaic UI sessions when the model omits runtime metadata.
  }
  return "";
}

function normalizeDutId(value: unknown) {
  if (typeof value !== "string") {
    return value;
  }
  return value.trim().replace(/^dgx[\s_-]*(\d+)$/i, (_match, id) => `dgx-${id}`);
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

function compactDefinedJson(value: Record<string, unknown>, maxChars = MAX_EVENT_CHARS) {
  const defined = Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined && entry !== ""),
  );
  return Object.keys(defined).length > 0 ? compactJson(defined, maxChars) : "";
}

function triageStatusContent(triageId: string, status: Record<string, unknown>) {
  const currentStatus = typeof status.status === "string" ? status.status : "unknown";
  const details = compactDefinedJson({
    root_cause: status.root_cause,
    severity: status.severity,
    confidence: status.confidence,
    error: status.error,
    next_action: status.next_action,
  });
  return [`Triage ${triageId}: ${currentStatus}`, details].filter(Boolean).join("\n");
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
      throw new Error(`Diagnostic-agent ${path} failed (${response.status}): ${compactJson(payload, 1000)}`);
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
    source: "diagnostic-agent",
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

async function suppressMosaicAlertForTriage(config: DiagnosticConfig, triageId: string) {
  const baseUrl = mosaicUiBaseUrlFromEventsUrl(config.subagentEventsUrl);
  if (!baseUrl || !triageId) {
    return;
  }

  await fetch(`${baseUrl}/api/alerts/suppress`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ triageId }),
  }).catch(() => {
    // Alert suppression is best-effort; diagnosis and terminal streaming should continue.
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

function terminalStatus(status: unknown) {
  const normalized = typeof status === "string" ? status.toLowerCase() : "";
  return ["complete", "completed", "failed", "error", "rejected"].includes(normalized);
}

function triageIdFrom(value: unknown) {
  return value && typeof value === "object" && typeof (value as Record<string, unknown>).triage_id === "string"
    ? ((value as Record<string, unknown>).triage_id as string)
    : "";
}

function collectionIssue(status: Record<string, unknown>, report: Record<string, unknown>) {
  const explicitFailure = stringParam(status.collection_failure) || stringParam(report.collection_failure);
  if (explicitFailure) {
    return explicitFailure;
  }
  const text = compactJson({
    root_cause: status.root_cause,
    fault_summary: report.fault_summary,
    caveats: report.caveats || status.caveats,
    timeline_text: report.timeline_text,
    additional_data_needed: report.additional_data_needed,
    tool_evidence: report.tool_evidence,
  }, 12000).toLowerCase();
  const failed = [
    "collector skipped",
    "dependency check failed",
    "not available on dut",
    "ssh command timed out",
    "command timed out",
  ].find(pattern => text.includes(pattern));
  return failed ? `collection did not produce usable telemetry (${failed})` : "";
}

async function pollTriage(
  config: DiagnosticConfig,
  triageId: string,
  options: SubagentOptions,
  pollIntervalMs: number,
  timeoutMs: number,
) {
  const started = Date.now();
  let lastStatus = "";
  while (Date.now() - started < timeoutMs) {
    const status = await fetchJson(config, `/api/v1/triage/${encodeURIComponent(triageId)}`, { method: "GET" }, Math.min(config.timeoutMs, 60_000));
    const currentStatus = typeof status.status === "string" ? status.status : "unknown";
    if (currentStatus !== lastStatus || status.root_cause || status.error) {
      lastStatus = currentStatus;
      await postSubagentEvent(
        options,
        terminalStatus(currentStatus) ? (currentStatus === "failed" || currentStatus === "error" ? "error" : "complete") : "delta",
        triageStatusContent(triageId, status),
      );
    }
    if (terminalStatus(currentStatus)) {
      return status;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Timed out waiting for diagnostic triage ${triageId} after ${Math.round(timeoutMs / 1000)} seconds`);
}

export default definePluginEntry({
  id: "diagnostic-agent",
  name: "NVDebug Diagnostic Agent",
  description: "HTTP tool bridge from OpenClaw to diagnostic-agent nvdebug hardware triage.",
  register(api) {
    const config = readConfig(api.pluginConfig);
    const registerTool = (tool: Parameters<typeof api.registerTool>[0]) => {
      if (isToolEnabled(api.pluginConfig, tool.name)) {
        api.registerTool(tool);
      }
    };

    registerTool({
      name: "diagnostic_health",
      label: "Diagnostic Agent Health",
      description: "Check whether diagnostic-agent is reachable and list dependency health.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute(toolCallId: string) {
        const events = subagentOptions(config, toolCallId, "diagnostic_health", "NVDebug health");
        await postSubagentEvent(events, "start", `Checking diagnostic-agent health at ${config.baseUrl}`);
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
      name: "diagnostic_analyze_dut",
      label: "NVDebug Analyze DUT",
      description:
        "Submit DUT hardware fault triage through diagnostic-agent. Use for XID, NVLink, NVSwitch, PCIe, ECC, NVMe, SPDM, RoT, CPU, dmesg, or 'what is wrong with node X' investigations.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["dut", "event_text", "mosaic_chat_session_key"],
        properties: {
          dut: {
            type: "object",
            additionalProperties: true,
            description: "DUTInfo-style object. Provide the hostname as id; diagnostic-agent resolves BMC details and credentials.",
          },
          event_text: {
            type: "string",
            description: "Dmesg/log/free-text fault signature that should drive analysis.",
          },
          profile_name: {
            type: "string",
            description: "Optional nvdebug collection profile override from the matched playbook.",
          },
          mosaic_chat_session_key: {
            type: "string",
            description: "Required when called from Mosaic. Copy the exact value from the [Mosaic Runtime] block so diagnostic-agent can stream nvdebug progress to the matching Terminal tab.",
          },
          wait: {
            type: "boolean",
            description: "If true, poll diagnostic-agent until the triage completes. Defaults to true.",
          },
          pollIntervalSeconds: {
            type: "number",
            description: "Polling interval while waiting for completion. Defaults to 5 seconds.",
          },
          pollTimeoutSeconds: {
            type: "number",
            description: "Maximum time to wait for completion. Defaults to 1800 seconds.",
          },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const dut = objectParam(rawParams.dut);
        const eventText = stringParam(rawParams.event_text);
        if (!dut) {
          throw new Error("dut is required");
        }
        applyDutDefaults(dut);
        if (!eventText) {
          throw new Error("event_text is required");
        }

        const wait = rawParams.wait !== false;
        const body: Record<string, unknown> = {
          dut,
          event_text: eventText,
        };
        const profileName = stringParam(rawParams.profile_name) || DEFAULT_MOSAIC_PROFILE;
        const mosaicSessionKey = stringParam(rawParams.mosaic_chat_session_key) || inferRecentMosaicSessionKey();
        if (profileName) body.profile_name = profileName;
        if (mosaicSessionKey) body.mosaic_chat_session_key = mosaicSessionKey;

        const displayDutId = typeof dut.id === "string" ? dut.id : "DUT";
        const events = subagentOptions(config, toolCallId, "diagnostic_analyze_dut", "NVDebug analysis");
        await postSubagentEvent(events, "start", `Submitting nvdebug diagnostic analysis for ${displayDutId}\n${eventText}`);

        try {
          const pollIntervalMs = Math.round(numberParam(rawParams.pollIntervalSeconds, DEFAULT_POLL_INTERVAL_MS / 1000, 1, 120) * 1000);
          const pollTimeoutMs = Math.round(numberParam(rawParams.pollTimeoutSeconds, config.timeoutMs / 1000, 10, 3600) * 1000);
          const attempts: Array<Record<string, unknown>> = [];
          for (let attempt = 1; attempt <= DEFAULT_ANALYZE_ATTEMPTS; attempt += 1) {
            const submitted = await fetchJson(config, "/api/v1/analyze-dut", {
              method: "POST",
              body: JSON.stringify(body),
            });
            const triageId = triageIdFrom(submitted);
            if (mosaicSessionKey && triageId) {
              await suppressMosaicAlertForTriage(config, triageId);
            }
            await postSubagentEvent(events, "delta", `Diagnostic triage queued: ${compactJson({ attempt, submitted })}`);

            if (!wait || !triageId) {
              await postSubagentEvent(events, "complete", `Diagnostic triage submitted. Poll ${submitted.poll_url || `/api/v1/triage/${triageId}`}.`);
              return jsonToolResult({ submitted, waited: false });
            }

            const status = await pollTriage(config, triageId, events, pollIntervalMs, pollTimeoutMs);
            const report = await fetchJson(config, `/api/v1/triage/${encodeURIComponent(triageId)}/report`, { method: "GET" }, Math.min(config.timeoutMs, 120_000))
              .catch(error => ({ reportFetchError: error instanceof Error ? error.message : String(error) }));
            const issue = collectionIssue(status, report);
            attempts.push({ triageId, issue });
            if (issue && attempt < DEFAULT_ANALYZE_ATTEMPTS) {
              await postSubagentEvent(events, "delta", `NVDebug collection incomplete; retrying (${issue})`);
              continue;
            }
            if (issue) {
              throw new Error(`NVDebug collection did not produce usable telemetry after ${DEFAULT_ANALYZE_ATTEMPTS} attempts: ${issue}`);
            }
            await postSubagentEvent(events, "complete", `NVDebug analysis complete for ${displayDutId}\n${compactDefinedJson({
              status: status.status,
              root_cause: status.root_cause,
              severity: status.severity,
              confidence: status.confidence,
            })}`);
            return jsonToolResult({ submitted, status, report, attempts });
          }
          throw new Error("NVDebug collection did not produce a result");
        } catch (error) {
          await postSubagentEvent(events, "error", error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    });

    registerTool({
      name: "diagnostic_triage_status",
      label: "Diagnostic Triage Status",
      description: "Fetch status/progress for an existing diagnostic-agent triage id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["triage_id"],
        properties: {
          triage_id: { type: "string", description: "Diagnostic triage id returned by diagnostic_analyze_dut or /api/v1/analyze-dut." },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const triageId = stringParam(rawParams.triage_id);
        if (!triageId) {
          throw new Error("triage_id is required");
        }
        const events = subagentOptions(config, toolCallId, "diagnostic_triage_status", "NVDebug triage status");
        await postSubagentEvent(events, "start", `Fetching diagnostic status for ${triageId}`);
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
      name: "diagnostic_triage_report",
      label: "Diagnostic Triage Report",
      description: "Fetch the full diagnostic-agent report for an existing triage id.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["triage_id"],
        properties: {
          triage_id: { type: "string", description: "Diagnostic triage id returned by diagnostic_analyze_dut or /api/v1/analyze-dut." },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const triageId = stringParam(rawParams.triage_id);
        if (!triageId) {
          throw new Error("triage_id is required");
        }
        const events = subagentOptions(config, toolCallId, "diagnostic_triage_report", "NVDebug report");
        await postSubagentEvent(events, "start", `Fetching diagnostic report for ${triageId}`);
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
