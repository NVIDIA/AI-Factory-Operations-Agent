// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type RunaiConfig = {
  baseUrl: string;
  mcpUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
};

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

let tokenCache: { key: string; token: string; expiresAt: number } | undefined;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function baseUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Run:ai baseUrl must be an HTTPS URL without embedded credentials");
  }
  return url;
}

async function boundedText(response: Response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    bytes += value.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Run:ai response exceeded the configured limit");
    }
    text += decoder.decode(value, { stream: true });
  }
}

function rpcPayload(text: string, id: number) {
  const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const candidates = normalized
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  if (candidates.length === 0) candidates.push(text);
  for (const candidate of candidates) {
    try {
      const payload = JSON.parse(candidate) as Record<string, unknown>;
      if (payload.id === id) return payload;
    } catch {
      // Ignore unrelated SSE events.
    }
  }
  throw new Error("Run:ai MCP returned no matching JSON-RPC response");
}

async function accessToken(config: RunaiConfig, signal: AbortSignal) {
  const key = `${config.baseUrl}\n${config.clientId}`;
  if (tokenCache?.key === key && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
  const response = await fetch(new URL("/api/v1/token", baseUrl(config.baseUrl)), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      grantType: "client_credentials",
    }),
    signal,
  });
  const payload = JSON.parse(await boundedText(response)) as { accessToken?: unknown; expiresIn?: unknown };
  if (!response.ok || typeof payload.accessToken !== "string") {
    throw new Error(`Run:ai service-account authentication failed (${response.status})`);
  }
  const lifetime = typeof payload.expiresIn === "number" ? payload.expiresIn : 300;
  tokenCache = { key, token: payload.accessToken, expiresAt: Date.now() + lifetime * 1000 };
  return payload.accessToken;
}

async function openSession(config: RunaiConfig) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let token: string;
  try {
    token = await accessToken(config, controller.signal);
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  let id = 0;

  const send = async (method: string, params: Record<string, unknown>, notification = false) => {
    const requestId = ++id;
    const response = await fetch(config.mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id: requestId }), method, params }),
      signal: controller.signal,
    });
    const text = await boundedText(response);
    if (!response.ok) throw new Error(`Run:ai MCP ${method} failed (${response.status}): ${text.slice(0, 500)}`);
    return { payload: notification ? undefined : rpcPayload(text, requestId), response };
  };

  const initialized = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mosaic", version: "0.1.0" },
  });
  const payload = initialized.payload as Record<string, unknown>;
  if (payload.error) throw new Error(`Run:ai MCP initialize failed: ${JSON.stringify(payload.error)}`);
  const sessionId = initialized.response.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("Run:ai MCP did not establish a session");
  headers["Mcp-Session-Id"] = sessionId;
  await send("notifications/initialized", {}, true);

  return {
    async request(method: string, params: Record<string, unknown>) {
      const response = (await send(method, params)).payload as Record<string, unknown>;
      if (response.error) throw new Error(`Run:ai MCP ${method} failed: ${JSON.stringify(response.error)}`);
      return response.result;
    },
    close() {
      clearTimeout(timer);
      void fetch(config.mcpUrl, {
        method: "DELETE",
        headers,
        signal: AbortSignal.timeout(config.timeoutMs),
      }).catch(() => undefined);
    },
  };
}

export function readOnlyTools(result: unknown): McpTool[] {
  if (!result || typeof result !== "object" || !Array.isArray((result as { tools?: unknown }).tools)) return [];
  return ((result as { tools: McpTool[] }).tools).filter(
    (tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint !== true,
  );
}

export function readOnlyToolCatalog(result: unknown) {
  const tools = readOnlyTools(result).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  return { count: tools.length, tools };
}

export async function listRunaiTools(config: RunaiConfig) {
  const session = await openSession(config);
  try {
    return readOnlyToolCatalog(await session.request("tools/list", {}));
  } finally {
    session.close();
  }
}

export async function callRunaiTool(config: RunaiConfig, name: string, args: Record<string, unknown>) {
  const session = await openSession(config);
  try {
    const available = readOnlyTools(await session.request("tools/list", {}));
    if (!available.some((tool) => tool.name === name)) {
      throw new Error(`Run:ai MCP tool ${name} is unavailable or is not explicitly read-only`);
    }
    return await session.request("tools/call", { name, arguments: args });
  } finally {
    session.close();
  }
}
