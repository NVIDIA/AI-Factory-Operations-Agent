// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { callRunaiTool, readOnlyToolCatalog, readOnlyTools } from "../files/openclaw-seed/extensions/runai/client.ts";

const config = {
  baseUrl: "https://runai.example.com",
  mcpUrl: "http://runai-mcp:8080/mcp",
  clientId: "test-client",
  clientSecret: "test-secret",
  timeoutMs: 1000,
};

test("filters the upstream tool list to explicit read-only tools", () => {
  assert.deepEqual(
    readOnlyTools({
      tools: [
        { name: "read", annotations: { readOnlyHint: true, destructiveHint: false } },
        { name: "write", annotations: { readOnlyHint: false, destructiveHint: true } },
        { name: "unclassified" },
      ],
    }).map((tool) => tool.name),
    ["read"],
  );
});

test("returns a compact read-only tool catalog", () => {
  assert.deepEqual(readOnlyToolCatalog({
    tools: [{
      name: "inspect",
      description: "Inspect a resource.",
      inputSchema: { type: "object" },
      outputSchema: { type: "object", properties: { large: { type: "string" } } },
      annotations: { readOnlyHint: true, destructiveHint: false },
    }],
  }), {
    count: 1,
    tools: [{ name: "inspect", description: "Inspect a resource.", inputSchema: { type: "object" } }],
  });
});

test("authenticates, initializes MCP, and calls an explicit read-only tool", async () => {
  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/api/v1/token")) {
      const request = JSON.parse(init.body);
      assert.equal(request.grantType, "client_credentials");
      return Response.json({ accessToken: "token", expiresIn: 300 });
    }
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const request = JSON.parse(init.body);
    methods.push(request.method);
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const results = {
      initialize: { protocolVersion: "2025-06-18" },
      "tools/list": {
        tools: [{ name: "whoami", annotations: { readOnlyHint: true, destructiveHint: false } }],
      },
      "tools/call": { content: [{ type: "text", text: "service-account" }] },
    };
    return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: results[request.method] })}\n\n`, {
      status: 200,
      headers: request.method === "initialize" ? { "mcp-session-id": "session" } : {},
    });
  };
  try {
    const result = await callRunaiTool(config, "whoami", {});
    assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list", "tools/call"]);
    assert.equal(result.content[0].text, "service-account");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects tools without an upstream read-only annotation", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/api/v1/token")) return Response.json({ accessToken: "token", expiresIn: 300 });
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const request = JSON.parse(init.body);
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-06-18" }
      : { tools: [{ name: "manage", annotations: { readOnlyHint: false, destructiveHint: true } }] };
    return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n\n`, {
      headers: request.method === "initialize" ? { "mcp-session-id": "session" } : {},
    });
  };
  try {
    await assert.rejects(() => callRunaiTool({ ...config, clientId: "other-client" }, "manage", {}), /not explicitly read-only/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("rejects plaintext Run:ai authentication before sending credentials", async () => {
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => {
    fetched = true;
    return Response.json({ accessToken: "token", expiresIn: 300 });
  };
  try {
    await assert.rejects(
      () => callRunaiTool({ ...config, baseUrl: "http://runai.example.com", clientId: "plaintext-client" }, "whoami", {}),
      /must be an HTTPS URL/,
    );
    assert.equal(fetched, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("bounds Run:ai authentication response size", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("x".repeat(4 * 1024 * 1024 + 1));
  try {
    await assert.rejects(
      () => callRunaiTool({ ...config, clientId: "oversized-client" }, "whoami", {}),
      /configured limit/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("applies the configured timeout to Run:ai authentication", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => await new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  try {
    await assert.rejects(
      () => callRunaiTool({ ...config, clientId: "timeout-client", timeoutMs: 10 }, "whoami", {}),
      /abort|timeout/i,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
