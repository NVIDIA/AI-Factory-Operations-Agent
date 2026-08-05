// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";

const bridge = fileURLToPath(new URL("mosaic-mcp.mjs", import.meta.url));

test("stdio bridge exposes and invokes configured tools", async t => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/openclaw/tools") {
      response.end(JSON.stringify({ tools: [{ name: "cluster_status", description: "Read cluster status." }] }));
      return;
    }
    if (request.url === "/api/openclaw/tools/call") {
      response.end(JSON.stringify({ result: { status: "healthy" } }));
      return;
    }
    response.end(JSON.stringify({ success: true }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const { port } = server.address();
  const child = spawn(process.execPath, [bridge], {
    env: { ...process.env, MOSAIC_URL: `http://127.0.0.1:${port}` },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => child.kill("SIGTERM"));

  const responses = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (line) {
        const response = JSON.parse(line);
        responses.set(response.id, response);
      }
    }
  });

  const request = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (responses.has(id)) return responses.get(id);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`MCP response ${id} timed out`);
  };

  const initialized = await request(1, "initialize");
  assert.equal(initialized.result.serverInfo.name, "mosaic");

  const listed = await request(2, "tools/list");
  assert.ok(listed.result.tools.some(tool => tool.name === "mosaic_chat"));
  assert.ok(listed.result.tools.some(tool => tool.name === "cluster_status"));

  const called = await request(3, "tools/call", {
    name: "cluster_status",
    arguments: {},
  });
  assert.match(called.result.content[0].text, /healthy/);
});
