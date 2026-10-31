// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const source = readFileSync(new URL("../files/openclaw-seed/extensions/iraop/index.ts", import.meta.url), "utf8")
  .replace('import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";', "const definePluginEntry = (entry) => entry;");
const javascript = stripTypeScriptTypes(source, { mode: "strip", sourceUrl: "iraop-response-test.ts" });
const { default: plugin } = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);

const queryPayload = (answer, sources = []) => ({
  answer, depth: "quick", collections_searched: ["validation"], sources,
});
const mcp = (payload) => ({ content: [{ type: "text", text: JSON.stringify(payload) }], isError: false });
const sourceReference = { source_file: "control.pdf", page_number: 2, collection: "validation", doc_id: "control.pdf", url: "/api/v1/documents/control.pdf" };

async function fixture(result, run) {
  const sessions = new Map();
  const events = [];
  let nextSession = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/mcp/sse") {
      const id = String(++nextSession);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      sessions.set(id, res);
      res.write(`event: endpoint\ndata: /mcp/messages?session=${id}\n\n`);
      req.on("close", () => sessions.delete(id));
      return;
    }
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text || "{}");
    if (url.pathname === "/events") {
      events.push(body);
      res.writeHead(200, { "Content-Type": "application/json" }).end('{"success":true}');
      return;
    }
    if (url.pathname === "/mcp/messages") {
      const stream = sessions.get(url.searchParams.get("session"));
      if (body.id !== undefined) {
        const response = body.method === "initialize"
          ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "iraop-test", version: "1" } }
          : result;
        stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: response })}\n\n`);
      }
      res.writeHead(202).end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const tools = new Map();
  plugin.register({
    pluginConfig: { baseUrl: `${base}/mcp/sse`, timeoutMs: 3000, subagentEventsUrl: `${base}/events` },
    registerTool: (tool) => tools.set(tool.name, tool),
  });
  try {
    await run(tools, events);
    for (let i = 0; i < 100 && !events.some((event) => ["complete", "error"].includes(event.phase)); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    for (const stream of sessions.values()) stream.end();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  return events;
}

async function query(result) {
  let value;
  const events = await fixture(result, async (tools) => {
    value = await tools.get("iraop_query").execute("validation-call", { question: "Read the indexed control document.", collections: ["validation"] });
  });
  return { value, events };
}

test("planning text without sources is incomplete and emits an error event", async () => {
  const original = mcp(queryPayload("I will search for the document."));
  const { value, events } = await query(original);
  assert.equal(JSON.parse(value.content[0].text).status, "incomplete");
  assert.deepEqual(value.details, original);
  assert.ok(events.some((event) => event.phase === "error" && event.content.includes("incomplete")));
  assert.ok(!events.some((event) => event.phase === "complete"));
});

test("fabricated source-free answer stays complete in details and is withheld from model content", async () => {
  const answer = "Verified code: MVE-2026-1000002. " + "未经检索的原始输出。".repeat(600);
  const original = mcp(queryPayload(answer));
  const { value } = await query(original);
  assert.equal(JSON.parse(value.content[0].text).status, "incomplete");
  assert.ok(!value.content.map((item) => item.text).join("\n").includes("MVE-2026-1000002"));
  assert.equal(JSON.parse(value.details.content[0].text).answer, answer);
  assert.deepEqual(value.details, original);
});

for (const [label, sources] of [
  ["missing", undefined], ["null", null], ["wrong type", "control.pdf"],
  ["empty reference", [{}]], ["invalid page", [{ ...sourceReference, page_number: 0 }]],
]) {
  test(`research with ${label} sources is incomplete`, async () => {
    const payload = queryPayload("A factual claim.", sources);
    if (label === "missing") delete payload.sources;
    const { value } = await query(mcp(payload));
    assert.equal(JSON.parse(value.content[0].text).status, "incomplete");
    assert.match(value.content[0].text, /incomplete/);
  });
}

test("an empty answer is incomplete even when a source is present", async () => {
  const { value } = await query(mcp(queryPayload("  ", [sourceReference])));
  assert.equal(JSON.parse(value.content[0].text).status, "incomplete");
});

test("valid sourced answer remains complete and evidence notes do not mutate raw details", async () => {
  const original = mcp(queryPayload("A documented statement. " + "完整原文。".repeat(700), [sourceReference]));
  const { value, events } = await query(original);
  assert.ok(!value.isError);
  assert.deepEqual(value.details, original);
  assert.equal(value.content.length, original.content.length + 1);
  assert.notEqual(value.content, value.details.content);
  assert.equal(value.content[1].text, original.content[0].text);
  assert.ok(events.some((event) => event.phase === "complete"));
  assert.ok(!events.some((event) => event.phase === "error"));
});

test("structured MCP query payload can carry the source references", async () => {
  const payload = queryPayload("Documented answer.", [sourceReference]);
  const original = { content: [{ type: "text", text: payload.answer }], structuredContent: payload };
  const { value } = await query(original);
  assert.ok(!value.isError);
  assert.deepEqual(value.details, original);
});

test("unreadable research payload is incomplete with the raw response retained", async () => {
  const original = { content: [{ type: "text", text: "Unstructured unsupported response." }] };
  const { value } = await query(original);
  assert.equal(JSON.parse(value.content[0].text).status, "incomplete");
  assert.deepEqual(value.details, original);
});

test("MCP error remains a rejected tool call and error event", async () => {
  const original = { content: [{ type: "text", text: "Backend query failed." }], isError: true };
  const events = await fixture(original, async (tools) => {
    await assert.rejects(tools.get("iraop_query").execute("error-call", { question: "Read the document." }), /Backend query failed/);
  });
  assert.ok(events.some((event) => event.phase === "error"));
  assert.ok(!events.some((event) => event.phase === "complete"));
});

test("collection listing does not require answer or sources fields", async () => {
  const original = { content: [{ type: "text", text: JSON.stringify([{ name: "validation", doc_count: 4 }]) }] };
  await fixture(original, async (tools) => {
    const value = await tools.get("iraop_list_collections").execute();
    assert.deepEqual(value.details, original);
    assert.deepEqual(value.content, original.content);
    assert.ok(!value.isError);
  });
});
