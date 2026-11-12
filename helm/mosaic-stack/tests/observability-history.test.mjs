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

async function fixture(t, respond, extra = {}, clockRespond) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    requests.push({ method: req.method, url });
    res.setHeader("Content-Type", "application/json");
    try {
      const clock = url.searchParams.get("query")?.startsWith("timestamp(");
      const data = clock && clockRespond ? clockRespond(url) : respond(url);
      if (clock && !clockRespond) {
        for (const series of data.result || []) {
          if (series.values) series.values = series.values.map(([time]) => [time, String(time)]);
        }
      }
      res.end(JSON.stringify({ status: "success", data, ...extra }));
    } catch {
      res.writeHead(503).end(JSON.stringify({ status: "error" }));
    }
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
  assert.equal(older.result[0].values.at(-1).timestamp, lastPresent);
  assert.equal(older.result[0].values.at(-1).value, 0);
  assert.ok(requests.every(r => r.method === "GET" && [selector, `timestamp(${selector})`].includes(r.url.searchParams.get("query"))));
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
  assert.equal(series.values.at(-1).timestamp, end);
  assert.equal(series.values.at(-1).value, 241);
  assert.equal(series.pointCount, 242);
  assert.equal(series.returnedPointCount, 240);
  assert.equal(series.downsampled, true);
  assert.equal(series.values[0].timestamp, values[0][0]);
  assert.equal(series.values[0].value, 0);
  assert.equal(series.firstEvaluationTimestampIso, iso(values[0][0]));
  assert.equal(series.lastEvaluationTimestampIso, iso(end));
  assert.equal(series.lastEvaluationTimestampIso, "2026-11-06T00:00:00.000Z");
  assert.equal(result.endIso, "2026-11-06T00:00:00.000Z");
  assert.equal(result.historyEvidence.timestampMeaning, "query_evaluation_time");
});

test("sample values, including zero and NaN, are evidence rather than inferred health or outage timestamps", async t => {
  const values = [[end - 120, "0"], [end - 60, "NaN"], [end, "1"]];
  const { tools } = await fixture(t, () => ({ resultType: "matrix", result: [{ metric: labels, values }] }));
  const result = await tools.observability_range_query({ query: selector, end: iso(end) });
  assert.deepEqual(result.result[0].values.map(({ timestamp, value }) => ({ timestamp, value })), [
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
  assert.equal(result.result[0].firstEvaluationTimestampIso, null);
  assert.equal(result.result[0].lastEvaluationTimestampIso, null);
  assert.equal(result.result[0].returnedPointCount, 0);
});

test("instant query output remains compatible", async t => {
  const { tools } = await fixture(t, () => ({ resultType: "vector", result: [{ metric: labels, value: [end, "0"] }] }));
  const result = await tools.observability_query({ query: selector, time: iso(end) });
  assert.deepEqual(result.result, [{ metric: labels, value: { timestamp: end, value: 0 } }]);
  assert.equal(result.historyEvidence, undefined);
});

test("ordinary values retain their units while source clocks distinguish lookback evaluations", async t => {
  const sourceTime = lastPresent - 60;
  const evaluationTime = lastPresent + 180;
  const { tools } = await fixture(t, () => ({ resultType: "matrix", result: [{
    metric: labels, values: [[evaluationTime, "23"]],
  }] }), {}, () => ({ resultType: "matrix", result: [{
    metric: { gpu: labels.gpu, Hostname: labels.Hostname }, values: [[evaluationTime, String(sourceTime)]],
  }] }));
  const result = await tools.observability_range_query({ query: selector, start: iso(lastPresent), end: iso(evaluationTime) });
  assert.deepEqual(result.result[0].values[0], {
    timestamp: evaluationTime, value: 23, sampleTimestamp: sourceTime, sampleTimeIso: iso(sourceTime),
  });
  assert.equal(result.result[0].lastEvaluationTimestampIso, iso(evaluationTime));
  assert.equal(result.result[0].lastSampleTimeIso, iso(sourceTime));
  assert.equal(result.sampleTimeStatus, "available");
});

test("a failed or unusable source clock preserves metric evidence and reports unknown sample times", async t => {
  for (const clock of [
    () => { throw new Error("backend unavailable"); },
    () => ({ resultType: "scalar", result: [] }),
    () => ({ resultType: "matrix", result: [{ metric: labels, values: [[end, "NaN"]] }] }),
  ]) {
    const { tools } = await fixture(t, () => ({ resultType: "matrix", result: [{ metric: labels, values: [[end, "0"]] }] }), {}, clock);
    const result = await tools.observability_range_query({ query: selector, end: iso(end) });
    assert.equal(result.result[0].values[0].value, 0);
    assert.equal(result.result[0].values[0].sampleTimeIso, undefined);
    assert.equal(result.sampleTimeStatus, "unavailable");
    assert.equal(result.historyEvidence.incidentOnsetDetermined, false);
  }
});

// Optional real backend coverage uses the generated, isolated history fixture.
test("real Prometheus preserves source times through lookback and compaction", {
  skip: !process.env.MOSAIC_HISTORY_TEST_URL,
}, async () => {
  const tools = {};
  plugin.register({
    pluginConfig: { prometheusUrl: process.env.MOSAIC_HISTORY_TEST_URL, grafanaEnabled: false },
    registerTool: tool => { tools[tool.name] = async params => (await tool.execute("history-test", params)).details; },
  });
  for (const [host, last, value] of [
    ["fixture-gpu-a", end - 3 * 86400 - 60, 42],
    ["fixture-gpu-b", null, null],
    ["fixture-gpu-c", end, 0],
    ["fixture-gpu-d", end - 2 * 3600 - 60, 23],
  ]) {
    const source = `DCGM_FI_DEV_GPU_UTIL{Hostname="${host}",gpu="0"}`;
    const recent = await tools.observability_range_query({ query: source, end: iso(end), rangeMinutes: 60 });
    assert.equal(recent.result.length > 0, host === "fixture-gpu-c");
    assert.equal(recent.historyEvidence.incidentOnsetDetermined, false);
    const history = await tools.observability_range_query({
      query: source,
      end: iso(end), rangeMinutes: 10080, stepSeconds: 60, maxPoints: 240,
    });
    assert.equal(history.historyEvidence.incidentOnsetDetermined, false);
    if (last === null) {
      assert.deepEqual(history.result, []);
      continue;
    }
    const series = history.result[0];
    assert.equal(series.values.at(-1).value, value);
    assert.equal(series.values.at(-1).sampleTimestamp, last);
    assert.equal(series.values.at(-1).sampleTimeIso, iso(last));
    assert.equal(series.lastSampleTimeIso, iso(last));
    assert.ok(series.values.length <= 240);
    assert.ok(series.downsampled);
    // A timestamp query must identify source time even when evaluation outlives it.
    if (last < end) assert.ok(series.values.at(-1).timestamp > last);
    const sample = await tools.observability_query({ query: source, time: iso(last) });
    assert.equal(sample.result[0].value.value, value);
  }
});

for (const extra of [{ warnings: ["Partial backend response"] }, { isPartial: true }]) {
  test("partial backend responses retain their evidence warning instead of establishing absence", async t => {
    const { tools } = await fixture(t, () => ({ resultType: "matrix", result: [] }), extra);
    const result = await tools.observability_range_query({ query: selector, end: iso(end) });
    assert.equal(result.historyEvidence.status, "incomplete_response");
    assert.equal(result.historyEvidence.incidentOnsetDetermined, false);
    for (const [key, value] of Object.entries(extra)) assert.deepEqual(result[key], value);
  });
}

test("instant range-vector samples are not mislabeled as range evaluation boundaries", async t => {
  const { tools } = await fixture(t, () => ({ resultType: "matrix", result: [{
    metric: labels, values: [[end - 60, "0"], [end, "1"]],
  }] }));
  const result = await tools.observability_query({ query: `${selector}[5m]`, time: iso(end) });
  assert.equal(result.result[0].firstEvaluationTimestampIso, undefined);
  assert.equal(result.result[0].values[0].timestamp, end - 60);
});
