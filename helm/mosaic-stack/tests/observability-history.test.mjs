// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import test from "node:test";

const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === "openclaw/plugin-sdk/plugin-entry"
    ? { url: "data:text/javascript,export const definePluginEntry = x => x;", shortCircuit: true }
    : next(specifier, context);
} });
const { default: plugin } = await import("../files/openclaw-seed/extensions/observability/index.ts");
hooks.deregister();

async function fixture(t, respond) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, url });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "success", data: respond(url) }));
  }).listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const tools = {};
  plugin.register({
    pluginConfig: { prometheusUrl: `http://127.0.0.1:${server.address().port}`, grafanaEnabled: false },
    registerTool: tool => { tools[tool.name] = async params => (await tool.execute("history-test", params)).details; },
  });
  return { tools, requests };
}

const end = Date.parse("2026-11-06T00:00:00Z") / 1000;
const lastPresent = end - 3 * 86400;
const selector = 'DCGM_FI_DEV_GPU_UTIL{Hostname="fixture-gpu-a",gpu="0"}';
const labels = { __name__: "DCGM_FI_DEV_GPU_UTIL", Hostname: "fixture-gpu-a", gpu: "0" };
const iso = seconds => new Date(seconds * 1000).toISOString();

test("last-seen tool obeys the same endpoint and tool enablement controls as other metrics tools", () => {
  for (const [config, expected] of [
    [{}, false],
    [{ prometheusUrl: "https://metrics.example" }, true],
    [{ prometheusUrl: "https://metrics.example", disabledTools: ["observability_metric_last_seen"] }, false],
    [{ prometheusUrl: "https://metrics.example", enabledTools: ["observability_query"] }, false],
    [{ prometheusUrl: "https://metrics.example", enabledTools: ["observability_metric_last_seen"] }, true],
  ]) {
    const names = [];
    plugin.register({ pluginConfig: { ...config, grafanaEnabled: false }, registerTool: tool => names.push(tool.name) });
    assert.equal(names.includes("observability_metric_last_seen"), expected);
  }
});

test("three-day outage: an empty recent window is not an incident start; older data remains queryable", async t => {
  const { tools, requests } = await fixture(t, url => {
    const values = [];
    const start = Number(url.searchParams.get("start"));
    const stop = Number(url.searchParams.get("end"));
    const step = Number(url.searchParams.get("step"));
    for (let ts = start; ts <= Math.min(stop, lastPresent); ts += step) values.push([ts, "0"]);
    return { resultType: "matrix", result: values.length ? [{ metric: labels, values }] : [] };
  });
  for (const rangeMinutes of [60, 180, 1440]) {
    const result = await tools.observability_range_query({ query: selector, end: iso(end), rangeMinutes });
    assert.deepEqual(result.result, []);
    assert.equal(result.start, end - rangeMinutes * 60);
    assert.equal(result.historyEvidence.status, "no_samples_in_window");
    assert.equal(result.historyEvidence.incidentOnsetDetermined, false);
  }
  const older = await tools.observability_range_query({ query: selector, end: iso(end), rangeMinutes: 5760, maxPoints: 10 });
  assert.equal(older.historyEvidence.status, "samples_returned");
  assert.equal(older.historyEvidence.incidentOnsetDetermined, false);
  assert.equal(older.result[0].pointCount, 1441);
  assert.equal(older.result[0].returnedPointCount, 10);
  assert.equal(older.result[0].downsampled, true);
  assert.deepEqual(older.result[0].values.at(-1), { timestamp: lastPresent, value: 0 });
  assert.ok(requests.every(r => r.method === "GET" && r.url.searchParams.get("query") === selector));
});

test("compaction retains both boundary points and discloses per-series sampling and series truncation", async t => {
  const values = Array.from({ length: 242 }, (_, i) => [end - (241 - i) * 60, String(i)]);
  const { tools } = await fixture(t, () => ({ resultType: "matrix", result: [
    { metric: labels, values },
    { metric: { ...labels, gpu: "1" }, values: values.slice(0, 4) },
  ] }));
  const result = await tools.observability_range_query({ query: selector, end: iso(end), rangeMinutes: 240, maxPoints: 240, maxSeries: 1 });
  assert.equal(result.seriesCount, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.result.length, 1);
  const series = result.result[0];
  assert.deepEqual(series.values.at(-1), { timestamp: end, value: 241 });
  assert.equal(series.pointCount, 242);
  assert.equal(series.returnedPointCount, 240);
  assert.equal(series.downsampled, true);
  assert.deepEqual(series.values[0], { timestamp: values[0][0], value: 0 });
  assert.equal(series.firstReturnedTimestamp, values[0][0]);
  assert.equal(series.lastReturnedTimestamp, end);
  assert.equal(series.lastReturnedTimestampIso, "2026-11-06T00:00:00.000Z");
  assert.equal(result.endIso, "2026-11-06T00:00:00.000Z");
  assert.equal(result.historyEvidence.timestampMeaning, "query_evaluation_time");
});

test("sample values, including zero and NaN, are evidence rather than inferred health or outage timestamps", async t => {
  const values = [[end - 120, "0"], [end - 60, "NaN"], [end, "1"]];
  const { tools } = await fixture(t, () => ({ resultType: "matrix", result: [{ metric: labels, values }] }));
  const result = await tools.observability_range_query({ query: selector, end: iso(end) });
  assert.deepEqual(result.result[0].values, [
    { timestamp: end - 120, value: 0 }, { timestamp: end - 60, value: "NaN" }, { timestamp: end, value: 1 },
  ]);
  assert.equal(result.result[0].downsampled, false);
  assert.equal(result.result[0].returnedPointCount, 3);
  assert.equal(result.historyEvidence.incidentOnsetDetermined, false);
});

test("no retained samples stays unknown even across seven days or an explicit older window", async t => {
  const { tools, requests } = await fixture(t, () => ({ resultType: "matrix", result: [] }));
  for (const params of [
    { end: iso(end), rangeMinutes: 10080 },
    { start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" },
  ]) {
    const result = await tools.observability_range_query({ query: selector, ...params });
    assert.equal(result.historyEvidence.status, "no_samples_in_window");
    assert.equal(result.historyEvidence.incidentOnsetDetermined, false);
    assert.deepEqual(result.result, []);
  }
  assert.equal(Number(requests[1].url.searchParams.get("start")), Date.parse("2026-10-01T00:00:00Z") / 1000);
});

test("empty series are not mistaken for returned sample evidence", async t => {
  const { tools } = await fixture(t, () => ({ resultType: "matrix", result: [{ metric: labels, values: [] }] }));
  const result = await tools.observability_range_query({ query: selector, end: iso(end) });
  assert.equal(result.historyEvidence.status, "no_samples_in_window");
  assert.equal(result.result[0].firstReturnedTimestamp, null);
  assert.equal(result.result[0].lastReturnedTimestamp, null);
  assert.equal(result.result[0].returnedPointCount, 0);
});

test("instant query output remains compatible", async t => {
  const { tools } = await fixture(t, () => ({ resultType: "vector", result: [{ metric: labels, value: [end, "0"] }] }));
  const result = await tools.observability_query({ query: selector, time: iso(end) });
  assert.deepEqual(result.result, [{ metric: labels, value: { timestamp: end, value: 0 } }]);
  assert.equal(result.historyEvidence, undefined);
});

test("timestamp values expose source time separately from evaluation time, only when explicitly requested", async t => {
  const sourceTime = lastPresent - 60;
  const evaluationTime = lastPresent + 180;
  const { tools, requests } = await fixture(t, url => ({
    resultType: url.pathname.endsWith("query_range") ? "matrix" : "vector",
    result: [{ metric: labels, ...(url.pathname.endsWith("query_range")
      ? { values: [[evaluationTime, String(sourceTime)]] }
      : { value: [evaluationTime, String(sourceTime)] }) }],
  }));
  const query = `timestamp(${selector})`;
  const instant = await tools.observability_query({ query, time: iso(evaluationTime), valueFormat: "unix_seconds" });
  assert.deepEqual(instant.result[0].value, {
    timestamp: evaluationTime, value: sourceTime, valueIso: "2026-11-02T23:59:00.000Z",
  });
  const range = await tools.observability_range_query({ query, start: iso(lastPresent), end: iso(evaluationTime), valueFormat: "unix_seconds" });
  assert.equal(range.result[0].lastReturnedTimestampIso, "2026-11-03T00:03:00.000Z");
  assert.deepEqual(range.result[0].values[0], instant.result[0].value);
  const plain = await tools.observability_query({ query, time: iso(evaluationTime) });
  assert.equal(plain.result[0].value.valueIso, undefined);
  assert.equal(plain.result[0].value.value, sourceTime);
  assert.ok(requests.every(request => !request.url.searchParams.has("valueFormat")));
  const count = requests.length;
  for (const tool of [tools.observability_query, tools.observability_range_query]) {
    await assert.rejects(tool({ query, valueFormat: "seconds" }), /valueFormat/);
  }
  assert.equal(requests.length, count);
});

test("non-finite or out-of-range timestamp values are not converted to fabricated dates", async t => {
  const { tools } = await fixture(t, () => ({ resultType: "matrix", result: [{ metric: labels, values: [[end - 60, "NaN"], [end, "1e100"]] }] }));
  const result = await tools.observability_range_query({ query: `timestamp(${selector})`, end: iso(end), valueFormat: "unix_seconds" });
  assert.deepEqual(result.result[0].values, [
    { timestamp: end - 60, value: "NaN", valueIso: null },
    { timestamp: end, value: 1e100, valueIso: null },
  ]);
});
