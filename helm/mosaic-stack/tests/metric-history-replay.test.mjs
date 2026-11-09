// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compareRuns, endpoint, initialMessages, parseOptions, runSuite, validateFixture } from "./metric-history-replay.mjs";
import { cases, replayCases, start, end, interval, metric } from "./fixtures/metric-history-cases.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const payload = () => ({ status: "success", data: { resultType: "matrix", result: cases.filter(item => item.count).map(item => ({
  metric: { __name__: metric, Hostname: item.host, gpu: "0" },
  values: Array.from({ length: item.count }, (_, i) => [start + i * interval, String(item.value)]),
})) } });
const read = path => JSON.parse(readFileSync(path, "utf8"));
const write = (path, value) => writeFileSync(path, JSON.stringify(value));
function scratch(t) {
  const path = mkdtempSync(join(tmpdir(), "mosaic-history-replay-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
async function server(t, handler) {
  const requests = [];
  const http = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const item = { method: req.method, url: new URL(req.url, "http://localhost"), headers: req.headers, body: raw ? JSON.parse(raw) : null };
      requests.push(item);
      const result = handler(item, requests.length);
      res.writeHead(result.httpStatus ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body ?? result));
    } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((accept, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", accept); });
  t.after(() => { http.closeAllConnections(); http.close(); });
  return { url: `http://127.0.0.1:${http.address().port}`, requests };
}
async function fixture(t) {
  return server(t, request => {
    assert.equal(request.method, "GET");
    const data = payload();
    if (request.url.pathname.endsWith("query_range")) { data.data.result = []; return data; }
    const query = request.url.searchParams.get("query");
    const range = Number(query.match(/\[(\d+)s\]$/)?.[1]);
    const stop = Number(request.url.searchParams.get("time"));
    const host = query.match(/Hostname="([^"]+)"/)?.[1];
    data.data.result = data.data.result.filter(item => !host || item.metric.Hostname === host)
      .map(item => ({ ...item, values: item.values.filter(([ts]) => ts > stop - range && ts <= stop) }))
      .filter(item => item.values.length);
    return data;
  });
}
function options(output, backend, model, extra = []) {
  return parseOptions(["--source", root, "--prometheus", backend, "--model-url", `${model}/v1`, "--model", "fixture-model",
    "--output", output, "--case", "three-day-gap-followup", "--repetitions", "1", ...extra]);
}
function response(content, tool_calls) {
  return { choices: [{ finish_reason: tool_calls ? "tool_calls" : "stop", message: { role: "assistant", content, ...(tool_calls ? { tool_calls } : {}) } }],
    usage: { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 } };
}
const historyCall = () => [{ id: "history-call", type: "function", function: { name: "observability_metric_last_seen", arguments: JSON.stringify({
  metric, labels: { Hostname: "fixture-gpu-a", gpu: "0" }, expectedIntervalSeconds: interval,
}) } }];

test("fixture validation checks all original timestamps and values, not just endpoints", () => {
  assert.equal(validateFixture(payload()).sampleCount, 30121);
  for (const mutate of [
    data => { data.data.result[0].values[1234][0]++; },
    data => { data.data.result[0].values[1234][1] = "0"; },
    data => { data.data.result[0].metric.extra = "ambiguous"; },
    data => { data.warnings = ["partial"]; },
    data => { data.data.result.pop(); },
    data => { data.data.result[0].values.pop(); },
  ]) {
    const data = payload(); mutate(data);
    assert.throws(() => validateFixture(data));
  }
});

test("prompts do not disclose ground truth or label the unknown history as a failure", () => {
  for (const scenario of replayCases) {
    const input = initialMessages("example skill", scenario);
    assert.equal(input.length, 2);
    assert.ok(input[0].content.includes("60 seconds"));
    assert.ok(input[1].content.includes(scenario.host));
    assert.ok(!JSON.stringify(input).includes(scenario.id));
    if (scenario.last && scenario.last !== end) assert.ok(!JSON.stringify(input).includes(new Date(scenario.last * 1000).toISOString()));
    assert.ok(!JSON.stringify(input).includes("7200"));
  }
});

test("configuration rejects credential URLs, production metrics, unknown controls and overwrites of fixed model fields", t => {
  for (const url of ["https://user:password@models.example/v1", "https://models.example/v1?api_key=secret", "file:///tmp/model"]) {
    assert.throws(() => endpoint(url, "model"));
  }
  assert.throws(() => endpoint("https://production.example", "fixture", true));
  assert.throws(() => options("/tmp/run", "http://127.0.0.1:19093", "http://models.example", ["--cache", "unknown"]));
  assert.throws(() => options("/tmp/run", "http://127.0.0.1:19093", "http://models.example", ["--max-turns", "0"]));
  for (const value of ["NaN", "-1", "3"]) assert.throws(() => options("/tmp/run", "http://127.0.0.1:19093", "http://models.example", ["--temperature", value]));
  const dir = scratch(t), path = join(dir, "options.json");
  for (const invalid of [{ messages: [] }, { top_p: 0 }, { top_p: "0.95" }, { chat_template_kwargs: [] }, { reasoning_effort: false }]) {
    write(path, invalid);
    assert.throws(() => options("/tmp/run", "http://127.0.0.1:19093", "http://models.example", ["--model-options", path]));
  }
});

test("real plugin replay preserves the follow-up, original evidence, all messages, and auth separation", async t => {
  const dir = scratch(t), backend = await fixture(t);
  const priorKey = process.env.MOSAIC_REPLAY_API_KEY;
  process.env.MOSAIC_REPLAY_API_KEY = "synthetic-test-key-never-in-artifacts";
  t.after(() => { if (priorKey === undefined) delete process.env.MOSAIC_REPLAY_API_KEY; else process.env.MOSAIC_REPLAY_API_KEY = priorKey; });
  const model = await server(t, (request, count) => {
    assert.equal(request.headers.authorization, "Bearer synthetic-test-key-never-in-artifacts");
    assert.equal(request.url.pathname, "/v1/chat/completions");
    assert.equal(request.body.model, "fixture-model");
    assert.equal(request.body.temperature, 1);
    assert.equal(request.body.top_p, 0.95);
    assert.deepEqual(request.body.chat_template_kwargs, { enable_thinking: false });
    assert.equal(request.body.cache_salt, undefined);
    if (count === 1) {
      assert.equal(request.body.messages.length, 6);
      assert.equal(request.body.messages.at(-1).content, "这个问题是什么时候开始的？请给出时间依据。");
      return response(null, historyCall());
    }
    const evidence = JSON.parse(request.body.messages.at(-1).content);
    assert.equal(evidence.lastSample.iso, "2026-11-02T23:59:00.000Z");
    assert.equal(evidence.firstExpectedMissing.iso, "2026-11-03T00:00:00.000Z");
    return response("Last actual source sample: 2026-11-02T23:59:00Z. With a 60-second cadence, the first expected missing sample is 2026-11-03T00:00:00Z. Physical fault time is unproven.");
  });
  const output = join(dir, "run"), before = Date;
  const config = join(dir, "model-options.json");
  write(config, { top_p: 0.95, chat_template_kwargs: { enable_thinking: false } });
  const result = await runSuite(options(output, backend.url, model.url, ["--temperature", "1", "--model-options", config]));
  assert.equal(globalThis.Date, before);
  assert.equal(result[0].stop, "stop");
  assert.equal(result[0].modelTurns, 2);
  assert.equal(result[0].toolCalls, 1);
  assert.equal(result[0].backendRequests, 6); // seeded range + five raw windows
  assert.equal(result[0].answerReview, "pending");
  assert.equal(read(join(output, "manifest.json")).fixture.sampleCount, 30121);
  assert.equal(read(join(output, "manifest.json")).settings.temperature, 1);
  const run = join(output, "three-day-gap-followup-1");
  const messages = read(join(run, "transcript.json"));
  assert.equal(messages.length, 9);
  assert.equal(readFileSync(join(run, "answer.txt"), "utf8"), result[0].final);
  for (const entry of readdirSync(run)) assert.ok(!readFileSync(join(run, entry), "utf8").includes("synthetic-test-key-never-in-artifacts"));
  await assert.rejects(runSuite(options(output, backend.url, model.url)), /EEXIST/);
});

test("a failed recent-window query cannot become a fabricated empty follow-up context", async t => {
  const dir = scratch(t);
  const backend = await server(t, request => request.url.pathname.endsWith("query_range")
    ? { httpStatus: 503, body: { status: "error", error: "synthetic backend failure" } } : payload());
  const model = await server(t, () => { assert.fail("invalid seed reached the model"); });
  const result = await runSuite(options(join(dir, "run"), backend.url, model.url));
  assert.equal(result[0].stop, "replay_error");
  assert.equal(result[0].modelTurns, 0);
  assert.equal(model.requests.length, 0);
});

test("completion without investigation and exhausted turns remain visible failures, never correctness passes", async t => {
  const dir = scratch(t), backend = await fixture(t);
  const noTools = await server(t, () => response("The outage began three days ago."));
  const done = await runSuite(options(join(dir, "no-tools"), backend.url, noTools.url));
  assert.equal(done[0].completed, true);
  assert.equal(done[0].investigated, false);
  assert.equal(done[0].answerReview, "pending");
  const looping = await server(t, () => response(null, historyCall()));
  const budget = await runSuite(options(join(dir, "budget"), backend.url, looping.url, ["--max-turns", "1"]));
  assert.equal(budget[0].stop, "turn_budget");
  assert.equal(budget[0].completed, false);
  const unavailable = await server(t, () => ({ httpStatus: 503, body: { error: "model unavailable" } }));
  const failed = await runSuite(options(join(dir, "error"), backend.url, unavailable.url));
  assert.equal(failed[0].stop, "replay_error");
  assert.equal(failed[0].completed, false);
  assert.equal(read(join(dir, "error/three-day-gap-followup-1/error.json")).message, "Model HTTP 503");
});

test("comparisons require identical model, fixture, budgets, runner and complete case/repetition coverage", async t => {
  const dir = scratch(t), backend = await fixture(t);
  const model = await server(t, () => response("Review this answer separately."));
  const left = join(dir, "left"), right = join(dir, "right");
  await runSuite(options(left, backend.url, model.url));
  await runSuite(options(right, backend.url, model.url));
  const report = compareRuns(left, right);
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].candidate.answerReview, "pending");
  const manifestPath = join(right, "manifest.json"), original = read(manifestPath);
  for (const change of [{ model: "different-model" }, { modelRevision: "different-weights" }, { runnerSha256: "modified" },
    { fixture: { ...original.fixture, sha256: "other-data" } }, { settings: { ...original.settings, cache: "isolated" } },
    { settings: { ...original.settings, temperature: 1 } }]) {
    write(manifestPath, { ...original, ...change });
    assert.throws(() => compareRuns(left, right), /Not a matched/);
  }
  write(manifestPath, original);
  write(join(right, "summaries.json"), []);
  assert.throws(() => compareRuns(left, right), /Incomplete experiment/);
});
