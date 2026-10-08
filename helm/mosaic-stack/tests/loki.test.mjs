// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { registerLokiTools } from "../files/openclaw-seed/extensions/observability/loki.ts";
import { toolRequiresEdit } from "../files/openclaw-seed/extensions/automation-context.ts";

function tools(config) {
  const registered = {};
  registerLokiTools(config, tool => { registered[tool.name] = params => tool.execute("test", params); });
  return registered;
}

test("Loki is opt-in, read-only, and rejects credentials in URLs", () => {
  assert.deepEqual(tools({}), {});
  for (const url of ["ftp://logs.example.com", "https://user:secret@logs.example.com", "https://logs.example.com?token=secret"]) {
    assert.throws(() => tools({ lokiUrl: url }), /HTTP/);
  }
  for (const name of Object.keys(tools({ lokiUrl: "http://localhost" }))) assert.equal(toolRequiresEdit(name), false);
});

test("discovers labels and queries bounded timestamped logs with operator credentials", async t => {
  const requests = [];
  let mode = "normal";
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ url, headers: req.headers, method: req.method });
    if (mode === "redirect") { res.writeHead(302, { Location: "/elsewhere" }); return res.end(); }
    if (mode === "error") { res.writeHead(401); return res.end("credential-must-not-leak"); }
    if (mode === "oversize") return res.end("x".repeat(2 * 1024 * 1024 + 1));
    if (mode === "invalid") return res.end("not json");
    const data = url.pathname.endsWith("/labels") ? ["host", "service", "job_id"]
      : url.pathname.endsWith("/series") ? [{host:"worker-a",service:"scheduler"},{host:"worker-b",service:"worker"}]
      : url.pathname.endsWith("/values") ? ["worker-a", "worker-b"]
      : { resultType: mode === "metric" ? "matrix" : "streams", result: [{
        stream: { host: "worker-a" }, values: [["1791490000123456789", "example event", { trace: "a" }]],
      }] };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "success", data }));
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const old = process.env.MOSAIC_LOKI_AUTHORIZATION;
  process.env.MOSAIC_LOKI_AUTHORIZATION = "Bearer test-only";
  t.after(() => { if (old === undefined) delete process.env.MOSAIC_LOKI_AUTHORIZATION; else process.env.MOSAIC_LOKI_AUTHORIZATION = old; });
  const api = tools({ lokiUrl: `http://127.0.0.1:${server.address().port}/prefix`, lokiTenantId: "tenant-a" });
  const labels = await api.observability_log_labels({ limit: 2 });
  assert.deepEqual(labels.details.sources.map(source => source.label), ["host", "service"]);
  for (const source of labels.details.sources) assert.deepEqual(source.values, ["worker-a", "worker-b"]);
  assert.equal(labels.details.truncated, true);
  assert.deepEqual(labels.details.streamLabels, [{host:"worker-a",service:"scheduler"},{host:"worker-b",service:"worker"}]);
  assert.equal(labels.details.streamsTruncated, false);
  assert.deepEqual((await api.observability_log_labels({ label: "host" })).details.values, ["worker-a", "worker-b"]);
  const query = '{host="worker-a"} |= "event"';
  const logs = await api.observability_logs({ query, limit: 1, start: "2026-10-01T00:00:00Z", end: "2026-10-01T01:00:00Z", direction: "forward" });
  assert.equal(logs.details.streams[0].entries[0][0], "1791490000123456789");
  assert.equal(logs.details.limitReached, true);
  assert.deepEqual(logs.details.streams[0].entries[0][2], { trace: "a" });
  assert.equal(requests.at(-1).url.searchParams.get("query"), query);
  assert.equal(requests.at(-1).url.searchParams.get("direction"), "forward");
  for (const request of requests) {
    assert.equal(request.method, "GET");
    assert.equal(request.headers.authorization, "Bearer test-only");
    assert.equal(request.headers["x-scope-orgid"], "tenant-a");
    assert.ok(request.url.pathname.startsWith("/prefix/loki/api/v1/"));
    assert.ok(Date.parse(request.url.searchParams.get("end")) - Date.parse(request.url.searchParams.get("start")) <= 86400000);
  }
  const before = requests.length;
  for (const params of [{ limit: 1001 }, { limit: -1 }, { direction: "invalid" }, { start: "bad" }, { start: "2026-01-01", end: "2026-01-03" }, { start: "2026-01-03", end: "2026-01-01" }]) {
    await assert.rejects(api.observability_logs({ query, ...params }));
  }
  assert.equal(requests.length, before);
  for (const [responseMode, message] of [["error", /HTTP 401/], ["oversize", /2 MiB/], ["invalid", /invalid JSON/], ["metric", /log streams/], ["redirect", /fetch failed/]]) {
    mode = responseMode;
    await assert.rejects(api.observability_logs({ query }), error => message.test(error.message) && !error.message.includes("credential-must-not-leak"));
  }
});

test("Loki registers without Prometheus and absent endpoints register no query tools", async () => {
  const { registerHooks } = await import("node:module");
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "openclaw/plugin-sdk/plugin-entry") return {
        url: "data:text/javascript,export const definePluginEntry = entry => entry;", shortCircuit: true,
      };
      return nextResolve(specifier, context);
    },
  });
  try {
    const { default: plugin } = await import("../files/openclaw-seed/extensions/observability/index.ts");
    const names = config => {
      const result = [];
      plugin.register({ pluginConfig: {grafanaEnabled:false, ...config}, registerTool: tool => result.push(tool.name) });
      return result;
    };
    assert.deepEqual(names({}), []);
    assert.deepEqual(names({lokiUrl:"http://logs.example.com"}).sort(), ["observability_log_labels", "observability_logs"]);
    assert.ok(names({prometheusUrl:"http://metrics.example.com"}).includes("observability_query"));
  } finally { hooks.deregister(); }
});
