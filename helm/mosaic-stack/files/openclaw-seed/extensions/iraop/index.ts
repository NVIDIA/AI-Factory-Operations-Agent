// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// Default SSE endpoint — in-cluster DNS for the iraop Service. Override via
// plugins.entries.iraop.baseUrl in openclaw.json if the service moves.
const DEFAULT_SSE_URL = "http://iraop:8000/mcp/sse";
const DEFAULT_TIMEOUT_MS = 240_000;

type SubagentPhase = "start" | "delta" | "complete" | "error";

type SubagentOptions = {
  toolCallId: string;
  toolName: string;
  title: string;
  subagentEventsUrl?: string;
};

function resolveSubagentEventsUrl(pluginConfig: unknown): string {
  if (
    pluginConfig &&
    typeof pluginConfig === "object" &&
    "subagentEventsUrl" in pluginConfig &&
    typeof (pluginConfig as { subagentEventsUrl?: unknown }).subagentEventsUrl === "string"
  ) {
    return (pluginConfig as { subagentEventsUrl: string }).subagentEventsUrl;
  }
  return "http://mosaic-ui:3000/api/subagents/events";
}

function readConfig(
  pluginConfig: unknown,
): { sseUrl: string; timeoutMs: number; apiKey: string; subagentEventsUrl: string } {
  let sseUrl = DEFAULT_SSE_URL;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let apiKey = "";
  if (pluginConfig && typeof pluginConfig === "object") {
    const cfg = pluginConfig as Record<string, unknown>;
    if (typeof cfg.baseUrl === "string" && cfg.baseUrl.trim()) {
      sseUrl = cfg.baseUrl.trim();
    }
    if (typeof cfg.timeoutMs === "number" && Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0) {
      timeoutMs = cfg.timeoutMs;
    }
    if (typeof cfg.apiKey === "string") {
      const raw = cfg.apiKey.trim();
      // OpenClaw leaves `${VAR}` as a literal when the env var is unset. Sending
      // that as a bearer token is worse than sending nothing: iraop would count
      // it as a rejected caller rather than an unconfigured one, which is the
      // signal the 2026-08-20 enforcement gate is read from.
      apiKey = raw.startsWith("${") ? "" : raw;
    }
  }
  return { sseUrl, timeoutMs, apiKey, subagentEventsUrl: resolveSubagentEventsUrl(pluginConfig) };
}

// iraop authenticates its HTTP API and its MCP surface with one shared bearer
// token. No key configured means no header at all, which is what every
// namespace sends today and what iraop still accepts while enforcement is off.
function authHeaders(apiKey: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function postSubagentEvent(
  options: SubagentOptions,
  phase: SubagentPhase,
  content: string,
) {
  if (!options.subagentEventsUrl) {
    return;
  }

  const payload = {
    id: `${options.toolCallId}-${phase}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    source: "iraop",
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    title: options.title,
    phase,
    status: phase === "complete" ? "complete" : phase === "error" ? "error" : "running",
    content,
    timestamp: new Date().toISOString(),
  };

  void fetch(options.subagentEventsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).catch(() => {
    // Subagent UI telemetry is best-effort and must not fail iraop execution.
  });
}

// Per-call MCP-over-SSE client. Opens a fresh stream, runs the initialize
// handshake, calls one tool, closes. Stateless + simple. Connection overhead
// (~200ms) is noise against iraop's 30-120s deep-research turnaround. If we
// ever need lower-latency shallow queries we can pool sessions — not worth it
// today.
async function callMcpTool(
  sseUrl: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  timeoutMs: number,
  apiKey = "",
  progress?: (message: string) => void,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };
  const pending = new Map<number, Pending>();
  let sessionUrl = "";
  let resolveSession: ((s: string) => void) | null = null;
  const sessionReady = new Promise<string>((r) => {
    resolveSession = r;
  });
  let streamError: Error | null = null;

  // Verbose log helper — prefix every line so it's grep-able in OpenClaw logs.
  const log = (msg: string) => console.error(`[iraop-plugin] ${toolName}: ${msg}`);
  log(`opening SSE ${sseUrl}`);
  progress?.(`Opening IRA MCP/SSE connection: ${sseUrl}`);

  const sseResp = await fetch(sseUrl, {
    headers: { Accept: "text/event-stream", ...authHeaders(apiKey) },
    signal: controller.signal,
  });
  if (!sseResp.ok || !sseResp.body) {
    clearTimeout(timer);
    if (sseResp.status === 401) {
      throw new Error(
        "iraop MCP SSE connect rejected (401): the iraop bearer token is missing or wrong. " +
          "Check IRAOP_API_KEY on the openclaw gateway and the iraop-auth Secret in this namespace.",
      );
    }
    throw new Error(`iraop MCP SSE connect failed: ${sseResp.status} ${sseResp.statusText}`);
  }
  log(`SSE open, status=${sseResp.status}`);
  progress?.("MCP/SSE stream is open; waiting for the session endpoint.");

  const reader = sseResp.body.getReader();
  const decoder = new TextDecoder();

  const pump = (async () => {
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are terminated by a blank line. Per spec the line
        // separator can be \r\n, \n, or \r — and so the event terminator can
        // be any of \r\n\r\n, \n\n, \r\r, or mixes. Normalize to \n first to
        // make parsing robust.
        buffer = buffer.replace(/\r\n?/g, "\n");
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of raw.split("\n")) {
            if (line.startsWith(":")) continue; // comment (e.g. ": ping - ...")
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) {
              // Strip exactly one optional leading space (per SSE spec) — using
              // .trim() would chew leading whitespace inside JSON payloads.
              const v = line.slice(5);
              data += v.startsWith(" ") ? v.slice(1) : v;
            }
          }
          if (event === "endpoint") {
            const base = new URL(sseUrl);
            sessionUrl = new URL(data.trim(), base).toString();
            log(`got endpoint ${sessionUrl}`);
            progress?.("MCP session endpoint received.");
            resolveSession?.(sessionUrl);
          } else if (event === "message") {
            if (!data) continue;
            try {
              const msg = JSON.parse(data) as Record<string, unknown>;
              if (typeof msg.id === "number") {
                const p = pending.get(msg.id);
                if (p) {
                  pending.delete(msg.id);
                  if ("error" in msg) p.reject(new Error(JSON.stringify(msg.error)));
                  else p.resolve(msg.result);
                }
              }
            } catch {
              // non-JSON data events are not part of the JSON-RPC protocol; ignore
            }
          }
        }
      }
    } catch (e) {
      streamError = e instanceof Error ? e : new Error(String(e));
      log(`pump error: ${streamError.message}`);
      // Fail any still-pending requests.
      for (const [, p] of pending) p.reject(streamError);
      pending.clear();
    }
  })();

  async function post(body: unknown): Promise<Response> {
    return fetch(sessionUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(apiKey) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  }

  // MCP-over-SSE authenticates each leg separately — the stream open and every
  // session POST are independent HTTP requests — so a 401 can surface here even
  // though the stream opened fine.
  const postError = (method: string, kind: string, status: number) =>
    new Error(
      status === 401
        ? `iraop MCP ${method} ${kind} rejected (401): the iraop bearer token is missing or wrong.`
        : `iraop MCP ${method} ${kind} failed: ${status}`,
    );

  let nextId = 1;
  async function rpc(method: string, params?: unknown): Promise<unknown> {
    const id = nextId++;
    const waiter = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    const resp = await post({ jsonrpc: "2.0", id, method, params });
    if (!resp.ok) {
      pending.delete(id);
      throw postError(method, "POST", resp.status);
    }
    return waiter;
  }

  async function notify(method: string, params?: unknown): Promise<void> {
    const resp = await post({ jsonrpc: "2.0", method, params });
    if (!resp.ok) {
      throw postError(method, "notify", resp.status);
    }
  }

  try {
    await sessionReady;
    log(`session ready, sending initialize`);
    progress?.("Initializing IRA MCP session.");
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "openclaw-iraop-plugin", version: "0.1.0" },
    });
    log(`initialize ok, sending notifications/initialized`);
    await notify("notifications/initialized");
    log(`calling tools/call name=${toolName}`);
    progress?.(`Calling IRA tool \`${toolName}\`; waiting for research to finish.`);
    const result = await rpc("tools/call", { name: toolName, arguments: toolArgs });
    log(`tools/call returned ok`);
    progress?.(`IRA tool \`${toolName}\` returned.`);
    return result;
  } catch (e) {
    log(`failed: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  } finally {
    clearTimeout(timer);
    try {
      await reader.cancel();
    } catch {
      // reader may already be closed
    }
    await pump;
  }
}

// iraop's MCP `tools/call` returns `{ content: [...], isError?: boolean, ... }`.
// OpenClaw's registerTool expects `{ content: [...] }` — pass it through, stash
// the full raw result under `details` for debugging.
function toOpenClawResult(mcpResult: unknown) {
  if (
    mcpResult &&
    typeof mcpResult === "object" &&
    Array.isArray((mcpResult as { content?: unknown }).content)
  ) {
    const r = mcpResult as { content: unknown[]; isError?: boolean };
    if (r.isError) {
      const text = r.content
        .map((c) => (c && typeof c === "object" && "text" in c ? (c as { text: unknown }).text : ""))
        .join("\n");
      throw new Error(typeof text === "string" && text ? text : "iraop tool call reported isError");
    }
    return { content: r.content, details: mcpResult };
  }
  const text = typeof mcpResult === "string" ? mcpResult : JSON.stringify(mcpResult, null, 2);
  return { content: [{ type: "text", text }], details: mcpResult };
}

function firstTextContent(result: { content?: unknown[] }) {
  return (result.content ?? [])
    .map((item) => {
      if (item && typeof item === "object" && "text" in item) {
        const text = (item as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function summarizeQueryResult(result: ReturnType<typeof toOpenClawResult>, elapsedMs: number) {
  const text = firstTextContent(result).trim();
  const elapsed = Math.max(1, Math.round(elapsedMs / 1000));
  if (!text) {
    return `IRA research completed in ${elapsed}s.`;
  }
  const excerpt = text.length > 2600 ? `${text.slice(0, 2600).trim()}\n\n…` : text;
  return `IRA research completed in ${elapsed}s.\n\n${excerpt}`;
}

export default definePluginEntry({
  id: "iraop",
  name: "iraop Plugin",
  description: "MCP-SSE bridge from OpenClaw to the iraop (Sequoia) documentation retrieval agent.",
  register(api) {
    const { sseUrl, timeoutMs, apiKey, subagentEventsUrl } = readConfig(api.pluginConfig);

    api.registerTool({
      name: "iraop_query",
      label: "iraop Query",
      description:
        "Search NVIDIA DGX SuperPOD, GB200, NVLink, BlueField, and on-prem infrastructure documentation via the Sequoia (iraop) retrieval service. Use when the user asks about DGX hardware, SuperPOD deployment, GB200 reference architecture, NVLink configuration, BlueField DPU setup, or any NVIDIA DGX on-prem infrastructure documentation. This tool can take 30 to 120 seconds to respond in quick mode and longer in deep mode — do not abort the call before 180 seconds have elapsed. NOT for: general ML/AI concepts, driver debugging, cluster runtime state (kubectl/logs), or questions unrelated to documented DGX infrastructure.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["question"],
        properties: {
          question: {
            type: "string",
            description: "The research question to answer.",
          },
          depth: {
            type: "string",
            enum: ["quick", "deep"],
            description:
              "quick (default) = single-pass search + synthesize, 30-120s, suitable for most chat questions. deep = multi-agent iterative research, several minutes, only request when the user explicitly asks for an exhaustive report.",
          },
          collections: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional list of iraop collection names to restrict the search to. Omit to search all collections. Use iraop_list_collections to discover available names.",
          },
        },
      },
      async execute(toolCallId: string, rawParams: Record<string, unknown>) {
        const question = typeof rawParams.question === "string" ? rawParams.question.trim() : "";
        if (!question) throw new Error("question is required");
        // Default depth to "quick" so chat-speed UX is the norm; iraop's
        // server-side default is "deep" (multi-agent, several minutes), which
        // contends with OpenClaw on the same shared vllm-nemotron endpoint
        // and is rarely what the user wants from a chat tool. Model can still
        // explicitly request "deep" when it judges the question warrants it.
        const depth = rawParams.depth === "deep" ? "deep" : "quick";
        const args: Record<string, unknown> = { question, depth };
        if (Array.isArray(rawParams.collections)) {
          const cleaned = rawParams.collections.filter((c): c is string => typeof c === "string" && c.length > 0);
          if (cleaned.length > 0) args.collections = cleaned;
        }
        const subagent: SubagentOptions = {
          toolCallId,
          toolName: "iraop_query",
          title: depth === "deep" ? "IRA deep research" : "IRA research",
          subagentEventsUrl,
        };
        postSubagentEvent(
          subagent,
          "start",
          [
            `Dispatching ${subagent.title}.`,
            `Question: ${question}`,
            `Depth: ${depth}`,
            Array.isArray(args.collections) ? `Collections: ${(args.collections as string[]).join(", ")}` : "Collections: all",
            "Note: IRA currently exposes MCP request/response over SSE, not internal research-token deltas.",
          ].join("\n"),
        );
        const startedAt = Date.now();
        try {
          const result = await callMcpTool(sseUrl, "query", args, timeoutMs, apiKey, (message) => {
            postSubagentEvent(subagent, "delta", message);
          });
          const openClawResult = toOpenClawResult(result);
          postSubagentEvent(subagent, "complete", summarizeQueryResult(openClawResult, Date.now() - startedAt));
          return openClawResult;
        } catch (error) {
          postSubagentEvent(
            subagent,
            "error",
            `IRA research failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
      },
    });

    api.registerTool({
      name: "iraop_list_collections",
      label: "iraop List Collections",
      description:
        "List all iraop document collections with doc counts and on-disk sizes. Use this to discover what knowledge bases are available before calling iraop_query or iraop_list_documents.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        const result = await callMcpTool(sseUrl, "list_collections", {}, 30_000, apiKey);
        return toOpenClawResult(result);
      },
    });

    api.registerTool({
      name: "iraop_list_documents",
      label: "iraop List Documents",
      description:
        "List source PDFs indexed in a given iraop collection. Returns filename, doc_id, download URL, and chunk count for each document.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["collection"],
        properties: {
          collection: { type: "string", description: "Collection name." },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const collection = typeof rawParams.collection === "string" ? rawParams.collection.trim() : "";
        if (!collection) throw new Error("collection is required");
        const result = await callMcpTool(sseUrl, "list_documents", { collection }, 30_000, apiKey);
        return toOpenClawResult(result);
      },
    });

    api.registerTool({
      name: "iraop_get_document",
      label: "iraop Get Document",
      description:
        "Return metadata and a download URL for an iraop corpus PDF by filename. MCP does not return PDF bytes — fetch them over HTTP from the returned url.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["filename"],
        properties: {
          filename: { type: "string", description: "PDF basename (no directory components)." },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const filename = typeof rawParams.filename === "string" ? rawParams.filename.trim() : "";
        if (!filename) throw new Error("filename is required");
        const result = await callMcpTool(sseUrl, "get_document", { filename }, 30_000, apiKey);
        return toOpenClawResult(result);
      },
    });
  },
});
