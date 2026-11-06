// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

type Params = Record<string, unknown>;
type Limits = { maxRequests?: number; timeoutMs?: number; maxResponseBytes?: number };
type Window = { start: number; end: number; startIso: string; endIso: string; query: string; status: string; seriesCount?: number; sampleCount?: number };
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
function elapsedDuration(seconds: number) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 86400)} days, ${Math.floor(whole % 86400 / 3600)} hours, ${Math.floor(whole % 3600 / 60)} minutes, ${whole % 60} seconds`;
}

function number(value: unknown, fallback: number, min: number, max: number, name: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function selection(params: Params) {
  const metric = params.metric;
  if (typeof metric !== "string" || !/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(metric) || metric.length > 256) {
    throw new Error("metric must be a plain Prometheus metric name, not a PromQL expression");
  }
  if (!params.labels || typeof params.labels !== "object" || Array.isArray(params.labels)) {
    throw new Error("labels must contain exact source label matches");
  }
  const labels = Object.entries(params.labels);
  if (!labels.length || labels.length > 20 || labels.some(([key, value]) =>
    !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || key === "__name__" ||
    typeof value !== "string" || !value.length || value.length > 512)) {
    throw new Error("Provide 1–20 nonempty exact label values; __name__ is selected by metric");
  }
  return { metric, labels: Object.fromEntries(labels) as Record<string, string>,
    selector: `${metric}{${labels.sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",")}}` };
}

async function request(url: URL, timeoutMs: number, maxBytes: number, fetcher: typeof fetch) {
  const response = await fetcher(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs))) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`backend_http_${response.status}`);
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of response.body!) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("response_size_limit");
    chunks.push(chunk);
  }
  let payload;
  try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("invalid_backend_json"); }
  if (payload.status !== "success") throw new Error("backend_query_failed");
  if (payload.warnings?.length || payload.isPartial === true) throw new Error("backend_partial_response_warning");
  if (payload.data?.resultType !== "matrix" || !Array.isArray(payload.data.result)) throw new Error("expected_raw_range_vector");
  return payload.data.result;
}

/** Walk adjacent raw range vectors, newest first. Unlike query_range this
 * returns original sample times without lookback reuse or step downsampling. */
export async function inspectMetricHistory(baseUrl: string, params: Params, fetcher = fetch, limits: Limits = {}) {
  const selected = selection(params);
  const lookbackHours = number(params.lookbackHours, 168, 1, 720, "lookbackHours");
  const expectedInterval = params.expectedIntervalSeconds === undefined ? null
    : number(params.expectedIntervalSeconds, 60, 1, 86400, "expectedIntervalSeconds");
  const parsedEnd = params.end === undefined ? Date.now() : typeof params.end === "string" ? Date.parse(params.end) : NaN;
  if (!Number.isFinite(parsedEnd)) throw new Error("end must be an ISO timestamp");
  const end = Math.floor(parsedEnd / 1000);
  const start = end - Math.ceil(lookbackHours * 3600);
  const windows: Window[] = [];
  const maxRequests = limits.maxRequests ?? 32;
  const deadline = performance.now() + (limits.timeoutMs ?? 20000);
  const base = {
    source: baseUrl, selector: selected.selector, requestedStart: start, requestedEnd: end,
    requestedStartIso: iso(start), requestedEndIso: iso(end), expectedIntervalSeconds: expectedInterval,
    timestampMeaning: "original_source_sample_time", intervalSemantics: "(start,end]",
  };
  let cursor = end;
  function result(status: string, extra: Params = {}) {
    return { ...base, status, searchedStart: cursor, searchedEnd: end, searchedStartIso: iso(cursor), searchedEndIso: iso(end),
      searchedDurationHours: (end - cursor) / 3600, maxSupportedLookbackHours: 720,
      coverageSummary: `Completed windows cover (${iso(cursor)}, ${iso(end)}]: ${(end - cursor) / 3600} hours actually checked, within a maximum requested budget of ${lookbackHours} hours.`,
      backendRetentionKnown: false, windows, ...extra };
  }
  for (let count = 0; cursor > start; count++) {
    if (count >= maxRequests || performance.now() >= deadline) {
      return result("incomplete", { reason: "search_budget_exhausted", conclusion: "The search limit was reached. Only completed windows are evidence; the incident onset remains unknown." });
    }
    const seconds = Math.min(cursor - start, count === 0 ? 3600 : count === 1 ? 21600 : 86400);
    const window: Window = { start: cursor - seconds, end: cursor, startIso: iso(cursor - seconds), endIso: iso(cursor),
      query: `${selected.selector}[${seconds}s]`, status: "pending" };
    windows.push(window);
    const url = new URL(`${baseUrl.replace(/\/+$/, "")}/api/v1/query`);
    url.searchParams.set("query", window.query);
    url.searchParams.set("time", String(cursor));
    let series;
    try {
      series = await request(url, Math.min(5000, deadline - performance.now()), limits.maxResponseBytes ?? 2 * 1024 * 1024, fetcher);
      for (const item of series) {
        if (!item.metric || item.metric.__name__ !== selected.metric ||
            Object.entries(selected.labels).some(([key, value]) => item.metric[key] !== value)) throw new Error("unexpected_source_labels");
        if (item.histograms?.length) throw new Error("native_histograms_not_supported");
        if (!Array.isArray(item.values)) throw new Error("invalid_sample_array");
        let previous = -Infinity;
        for (const sample of item.values) {
          if (!Array.isArray(sample) || sample.length !== 2 || typeof sample[0] !== "number" || !Number.isFinite(sample[0]) ||
              sample[0] <= window.start || sample[0] > window.end || sample[0] <= previous || typeof sample[1] !== "string" ||
              !/^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?Inf|NaN)$/.test(sample[1])) {
            throw new Error("invalid_source_sample");
          }
          previous = sample[0];
        }
      }
    } catch (error) {
      window.status = "failed";
      // Do not echo an arbitrary backend body, URL, or transport credential.
      const message = error instanceof Error ? error.message : "request_failed";
      const reason = /^(backend_http_\d+|response_size_limit|invalid_backend_json|backend_query_failed|backend_partial_response_warning|expected_raw_range_vector|unexpected_source_labels|native_histograms_not_supported|invalid_sample_array|invalid_source_sample)$/.test(message) ? message : "request_failed_or_timed_out";
      return result("incomplete", { reason, conclusion: "The search could not be completed. An error or partial response is not evidence of missing samples; incident onset is unknown." });
    }
    window.seriesCount = series.length;
    window.sampleCount = series.reduce((sum: number, item: { values: unknown[] }) => sum + item.values.length, 0);
    window.status = "complete";
    cursor = window.start;
    const matches = series.filter((item: { values: unknown[] }) => item.values.length > 0);
    if (matches.length > 1) {
      return result("ambiguous_series", { seriesCount: matches.length, candidateLabels: matches.slice(0, 20).map((item: { metric: Params }) => item.metric),
        candidatesTruncated: matches.length > 20, conclusion: "The selector matches multiple series. Refine exact source labels; do not combine their last-seen times into one incident onset." });
    }
    if (!matches.length) continue;
    const match = matches[0];
    const [timestamp, rawValue] = match.values.at(-1) as [number, string];
    const parsedValue = Number(rawValue);
    const ageSeconds = end - timestamp;
    const elapsedSinceLastSample = elapsedDuration(ageSeconds);
    const finite = Number.isFinite(parsedValue);
    const lastSample = { timestamp, iso: iso(timestamp), value: finite ? parsedValue : rawValue, finite, labels: match.metric };
    const firstExpectedMissing = expectedInterval !== null && ageSeconds >= expectedInterval
      ? { timestamp: timestamp + expectedInterval, iso: iso(timestamp + expectedInterval), assumption: "Provided sampling interval; not a measured physical fault time." } : null;
    const status = firstExpectedMissing ? "data_gap" : expectedInterval === null ? "sample_found" : "recent_sample";
    const conclusion = `Last actual source sample: ${lastSample.iso} (value ${rawValue}). No newer raw sample was found through ${iso(end)}. Elapsed since that sample: ${elapsedSinceLastSample}; this is not the duration of the searched window.` +
      (firstExpectedMissing ? ` With the provided ${expectedInterval}-second interval, the first missing expected sample is ${firstExpectedMissing.iso}. This is a data-gap estimate, not a proven network or collector failure time.`
        : expectedInterval === null ? " Sampling cadence is unknown; do not invent a first missed sample or physical fault time."
        : " The latest sample is within the provided sampling interval; a zero value is not missing data.") +
      (finite ? "" : " The sample is non-finite, so presence does not establish a healthy metric.");
    return result(status, { lastSample, ageSeconds, elapsedSinceLastSample, noNewerSamplesThrough: iso(end), firstExpectedMissing, conclusion });
  }
  return result("not_found_in_checked_history", { lastSample: null, firstExpectedMissing: null,
    conclusion: `No matching source samples were found in (${iso(start)}, ${iso(end)}]. It is unknown whether this exact series ever existed. The onset is unknown, not established to predate this window. Neither query boundary is an incident start. These ${lookbackHours} hours are the checked query budget, not backend retention or the tool's maximum. Older samples may be unavailable. Do not infer an outage duration from empty history.` });
}

export function metricHistoryTool(baseUrl: string) {
  return {
    name: "observability_metric_last_seen",
    label: "Metric Last Source Sample",
    description: "Find when a specific missing metric last reported. Automatically searches earlier raw sample windows and returns the last real source timestamp, not a query-window boundary or lookback evaluation time. Use for missing-data onset questions, including follow-ups after empty queries. Does not date threshold breaches or previous recovered gaps. Requires a backend supporting raw Prometheus range vectors; fails closed otherwise. Read-only and bounded.",
    parameters: { type: "object", additionalProperties: false, required: ["metric", "labels"], properties: {
      metric: { type: "string", description: "Discovered plain metric name, without functions or selectors." },
      labels: { type: "object", additionalProperties: { type: "string" }, minProperties: 1, maxProperties: 20, description: "Exact source label matches from the user's request or discovered series, e.g. Hostname and gpu. Do not broaden source scope." },
      end: { type: "string", description: "Investigation time as ISO 8601. Defaults to now." },
      lookbackHours: { type: "number", minimum: 1, maximum: 720, description: "Normally omit to search up to 168 hours (7 days). Override only for an explicit user history bound or to extend an exhausted search, up to 720 hours. An earlier empty chart window is not a history bound. This is not a retention claim." },
      expectedIntervalSeconds: { type: "number", minimum: 1, maximum: 86400, description: "Supply the sampling interval when independently known from the user or environment configuration. Enables a first-missed-expected-sample estimate; never an exact physical fault time. Omit when unknown." },
    } },
    async execute(_id: string, params: Params) {
      const output = await inspectMetricHistory(baseUrl, params);
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], details: output };
    },
  };
}
