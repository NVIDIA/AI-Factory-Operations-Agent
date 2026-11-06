// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectMetricHistory, metricHistoryTool } from "../files/openclaw-seed/extensions/observability/metric-history.ts";

const end = Date.parse("2026-11-06T00:00:00Z") / 1000;
const iso = seconds => new Date(seconds * 1000).toISOString();
const labels = { __name__: "DCGM_FI_DEV_GPU_UTIL", Hostname: "fixture-gpu-a", gpu: "0" };
const params = { metric: labels.__name__, labels: { Hostname: labels.Hostname, gpu: labels.gpu }, end: iso(end), expectedIntervalSeconds: 60 };
const endpoint = "https://metrics.example/select/17/prometheus/";
const payload = (result, extra = {}) => ({ status: "success", data: { resultType: "matrix", result }, ...extra });
const response = body => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

function backend(samples, metric = labels) {
  const requests = [];
  return { requests, fetch: async (url, options) => {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(url.pathname, "/select/17/prometheus/api/v1/query");
    const stop = Number(url.searchParams.get("time"));
    const seconds = Number(url.searchParams.get("query").match(/\[(\d+)s\]$/)[1]);
    requests.push({ query: url.searchParams.get("query"), start: stop - seconds, end: stop });
    const values = samples.filter(([ts]) => ts > stop - seconds && ts <= stop);
    return response(payload(values.length ? [{ metric, values }] : []));
  } };
}

test("finds a three-day gap in adjacent raw windows, preserving exact sample time and scope", async () => {
  const last = end - 3 * 86400 - 60;
  const mock = backend([[last - 60, "42"], [last, "42"]]);
  const result = await inspectMetricHistory(endpoint, params, mock.fetch);
  assert.equal(result.status, "data_gap");
  assert.deepEqual(result.lastSample, { timestamp: last, iso: "2026-11-02T23:59:00.000Z", value: 42, finite: true, labels });
  assert.equal(result.firstExpectedMissing.iso, "2026-11-03T00:00:00.000Z");
  assert.equal(result.ageSeconds, 259260);
  assert.equal(result.elapsedSinceLastSample, "3 days, 0 hours, 1 minutes, 0 seconds");
  assert.equal(result.backendRetentionKnown, false);
  assert.equal(result.timestampMeaning, "original_source_sample_time");
  assert.equal(mock.requests.length, 5);
  assert.deepEqual(mock.requests.map(r => r.end - r.start), [3600, 21600, 86400, 86400, 86400]);
  assert.ok(mock.requests.every(r => r.query.startsWith('DCGM_FI_DEV_GPU_UTIL{gpu="0",Hostname="fixture-gpu-a"}[')));
  for (let i = 1; i < mock.requests.length; i++) assert.equal(mock.requests[i].end, mock.requests[i - 1].start);
  assert.equal(result.searchedStart, mock.requests.at(-1).start);
  assert.equal(result.searchedEnd, end);
  assert.equal(result.searchedDurationHours, 79);
  assert.match(result.coverageSummary, /79 hours actually checked.*168 hours/);
  assert.deepEqual(result.windows.map(w => w.sampleCount), [0, 0, 0, 0, 2]);
});

test("a sample exactly on a window boundary is found once in the next (start,end] window", async () => {
  const mock = backend([[end - 3600, "0"]]);
  const result = await inspectMetricHistory(endpoint, params, mock.fetch);
  assert.equal(result.lastSample.timestamp, end - 3600);
  assert.deepEqual(result.windows.map(w => w.sampleCount), [0, 1]);
});

test("zero is present, unknown cadence is not fabricated, and non-finite presence is not health", async () => {
  for (const [raw, finite, value] of [["0", true, 0], ["NaN", false, "NaN"], ["+Inf", false, "+Inf"]]) {
    const mock = backend([[end - 30, raw]]);
    const result = await inspectMetricHistory(endpoint, params, mock.fetch);
    assert.equal(result.status, "recent_sample");
    assert.equal(result.lastSample.finite, finite);
    assert.equal(result.lastSample.value, value);
    assert.equal(result.firstExpectedMissing, null);
    if (!finite) assert.match(result.conclusion, /does not establish a healthy metric/);
  }
  const result = await inspectMetricHistory(endpoint, { ...params, expectedIntervalSeconds: undefined }, backend([[end - 9000, "1"]]).fetch);
  assert.equal(result.status, "sample_found");
  assert.equal(result.firstExpectedMissing, null);
  assert.equal(result.expectedIntervalSeconds, null);
});

test("empty history, a caller time bound, and a budget exhaustion are distinct evidence", async () => {
  for (const hours of [1, 2, 168, 720]) {
    const mock = backend([]);
    const result = await inspectMetricHistory(endpoint, { ...params, lookbackHours: hours }, mock.fetch);
    assert.equal(result.status, "not_found_in_checked_history");
    assert.equal(result.searchedStart, end - hours * 3600);
    assert.equal(result.lastSample, null);
    assert.equal(result.firstExpectedMissing, null);
    assert.equal(result.backendRetentionKnown, false);
    assert.equal(result.maxSupportedLookbackHours, 720);
    assert.match(result.conclusion, /unknown whether this exact series ever existed/);
    assert.match(result.conclusion, /not established to predate this window/);
    assert.ok(mock.requests.length <= 32);
    assert.match(result.conclusion, /onset is unknown/);
  }
  const mock = backend([]);
  const limited = await inspectMetricHistory(endpoint, params, mock.fetch, { maxRequests: 2 });
  assert.equal(limited.status, "incomplete");
  assert.equal(limited.reason, "search_budget_exhausted");
  assert.equal(limited.searchedStart, end - 7 * 3600);
  assert.equal(mock.requests.length, 2);
  const noTime = await inspectMetricHistory(endpoint, params, mock.fetch, { timeoutMs: 0 });
  assert.equal(noTime.status, "incomplete");
  assert.equal(noTime.searchedStart, end);
  assert.equal(mock.requests.length, 2);
});

test("multiple series require disambiguation, not a combined outage time", async () => {
  const series = Array.from({ length: 21 }, (_, i) => ({ metric: { ...labels, instance: `collector-${i}` }, values: [[end - 30, "0"]] }));
  const result = await inspectMetricHistory(endpoint, params, async () => response(payload(series)));
  assert.equal(result.status, "ambiguous_series");
  assert.equal(result.seriesCount, 21);
  assert.equal(result.candidateLabels.length, 20);
  assert.equal(result.candidatesTruncated, true);
  assert.equal(result.lastSample, undefined);
});

test("label values are escaped and arbitrary PromQL or broad source selections are rejected before I/O", async () => {
  const Hostname = 'host"\\\n) or up{a="b';
  const mock = backend([[end, "1"]], { ...labels, Hostname });
  const result = await inspectMetricHistory(endpoint, { ...params, labels: { Hostname, gpu: "0" } }, mock.fetch);
  assert.equal(result.status, "recent_sample");
  assert.equal(mock.requests[0].query, `DCGM_FI_DEV_GPU_UTIL{gpu="0",Hostname=${JSON.stringify(Hostname)}}[3600s]`);
  for (const invalid of [
    { metric: "sum(up)" }, { metric: "up[1d]" }, { labels: {} }, { labels: { Hostname: "" } },
    { labels: { "bad-key": "x" } }, { labels: { __name__: "up" } }, { labels: { Hostname: 1 } },
    { labels: [] }, { end: "not-a-date" }, { lookbackHours: 721 }, { lookbackHours: 0 },
    { lookbackHours: NaN }, { expectedIntervalSeconds: 0 },
  ]) await assert.rejects(inspectMetricHistory(endpoint, { ...params, ...invalid }, async () => { assert.fail("invalid input reached network"); }));
});

const sample = { metric: labels, values: [[end - 60, "1"]] };
for (const [name, body, reason] of [
  ["warnings", payload([], { warnings: ["partial response"] }), "backend_partial_response_warning"],
  ["partial flag", payload([], { isPartial: true }), "backend_partial_response_warning"],
  ["backend error", { status: "error", error: "SECRET" }, "backend_query_failed"],
  ["evaluated vector", { status: "success", data: { resultType: "vector", result: [] } }, "expected_raw_range_vector"],
  ["wrong source", payload([{ ...sample, metric: { ...labels, gpu: "1" } }]), "unexpected_source_labels"],
  ["wrong metric", payload([{ ...sample, metric: { ...labels, __name__: "up" } }]), "unexpected_source_labels"],
  ["native histogram", payload([{ ...sample, histograms: [[end, {}]] }]), "native_histograms_not_supported"],
  ["missing values", payload([{ metric: labels }]), "invalid_sample_array"],
  ["out of window", payload([{ ...sample, values: [[end + 1, "1"]] }]), "invalid_source_sample"],
  ["duplicate time", payload([{ ...sample, values: [[end, "1"], [end, "2"]] }]), "invalid_source_sample"],
  ["unordered time", payload([{ ...sample, values: [[end, "1"], [end - 30, "2"]] }]), "invalid_source_sample"],
  ["empty value", payload([{ ...sample, values: [[end, ""]] }]), "invalid_source_sample"],
]) test(`${name} fails closed and does not count a failed window as searched absence`, async () => {
  let count = 0;
  const result = await inspectMetricHistory(endpoint, params, async () => response(++count === 1 ? payload([]) : body));
  assert.equal(result.status, "incomplete");
  assert.equal(result.reason, reason);
  assert.equal(result.searchedStart, end - 3600);
  assert.deepEqual(result.windows.map(w => w.status), ["complete", "failed"]);
  assert.equal(result.lastSample, undefined);
  assert.ok(!JSON.stringify(result).includes("SECRET"));
});

test("transport, timeout, invalid JSON, oversized bodies and HTTP errors are not empty history", async () => {
  for (const [fetcher, limits, reason] of [
    [async () => { throw new Error("SECRET transport detail"); }, {}, "request_failed_or_timed_out"],
    [async () => new Response("SECRET invalid json"), {}, "invalid_backend_json"],
    [async () => new Response("SECRET", { status: 503 }), {}, "backend_http_503"],
    [async () => response(payload([sample])), { maxResponseBytes: 10 }, "response_size_limit"],
    [(_url, { signal }) => new Promise((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("test timeout fallback")), 1000);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }), { timeoutMs: 10 }, "request_failed_or_timed_out"],
  ]) {
    const result = await inspectMetricHistory(endpoint, params, fetcher, limits);
    assert.equal(result.status, "incomplete");
    assert.equal(result.reason, reason);
    assert.equal(result.searchedStart, end);
    assert.ok(!JSON.stringify(result).includes("SECRET"));
  }
});

test("tool schema and declared contract expose only bounded read-only investigation arguments", () => {
  const tool = metricHistoryTool(endpoint);
  assert.equal(tool.name, "observability_metric_last_seen");
  assert.deepEqual(tool.parameters.required, ["metric", "labels"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.lookbackHours.maximum, 720);
  const manifest = JSON.parse(readFileSync(new URL("../files/openclaw-seed/extensions/observability/openclaw.plugin.json", import.meta.url)));
  assert.ok(manifest.contracts.tools.includes(tool.name));
});

test("real Prometheus source timestamps (opt in with MOSAIC_HISTORY_TEST_URL for the documented fixture)", {
  skip: !process.env.MOSAIC_HISTORY_TEST_URL,
}, async () => {
  for (const [host, status, last, missing, value] of [
    ["fixture-gpu-a", "data_gap", "2026-11-02T23:59:00.000Z", "2026-11-03T00:00:00.000Z", 42],
    ["fixture-gpu-b", "not_found_in_checked_history", null, null, null],
    ["fixture-gpu-c", "recent_sample", "2026-11-06T00:00:00.000Z", null, 0],
    ["fixture-gpu-d", "data_gap", "2026-11-05T21:59:00.000Z", "2026-11-05T22:00:00.000Z", 23],
  ]) {
    const result = await inspectMetricHistory(process.env.MOSAIC_HISTORY_TEST_URL, { ...params, labels: { Hostname: host, gpu: "0" } });
    assert.equal(result.status, status, host);
    assert.equal(result.lastSample?.iso ?? null, last, host);
    assert.equal(result.firstExpectedMissing?.iso ?? null, missing, host);
    assert.equal(result.lastSample?.value ?? null, value, host);
  }
});
