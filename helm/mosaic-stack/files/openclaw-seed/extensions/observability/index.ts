// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerLokiTools } from "./loki.ts";
import { registerGrafanaTools } from "./grafana.ts";

type PrometheusVectorSample = {
  metric: Record<string, string>;
  value?: [number, string];
  values?: [number, string][];
};

type PrometheusResponse = {
  status: string;
  data?: {
    resultType: string;
    result: PrometheusVectorSample[];
  };
  warnings?: string[];
  isPartial?: boolean;
  errorType?: string;
  error?: string;
};

function resolveBaseUrl(pluginConfig: unknown): string {
  if (
    pluginConfig &&
    typeof pluginConfig === "object" &&
    "prometheusUrl" in pluginConfig &&
    typeof (pluginConfig as { prometheusUrl?: unknown }).prometheusUrl === "string"
  ) {
    const value = (pluginConfig as { prometheusUrl: string }).prometheusUrl.trim();
    if (value) return value.replace(/\/+$/, "");
  }
  return "";
}

function jsonToolResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function stringArrayConfig(pluginConfig: unknown, key: string) {
  if (!pluginConfig || typeof pluginConfig !== "object") {
    return [];
  }
  const raw = (pluginConfig as Record<string, unknown>)[key];
  return Array.isArray(raw)
    ? raw.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean)
    : [];
}

function isToolEnabled(pluginConfig: unknown, name: string) {
  const enabledTools = new Set(stringArrayConfig(pluginConfig, "enabledTools"));
  if (enabledTools.size > 0 && !enabledTools.has(name)) {
    return false;
  }
  return !new Set(stringArrayConfig(pluginConfig, "disabledTools")).has(name);
}

function stringParam(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberParam(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  return Math.max(min, Math.min(max, numberParam(value, fallback)));
}

function unixSeconds(value: Date) {
  return Math.floor(value.getTime() / 1000);
}

function parsePromValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function unixTimeIso(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function seriesKey(metric: Record<string, string>) {
  return JSON.stringify(Object.entries(metric).filter(([name]) => name !== "__name__").sort(([a], [b]) => a.localeCompare(b)));
}

function compactSample(timestamp: number, rawValue: string, times?: Map<number, number>) {
  const sampleTimestamp = times?.get(timestamp);
  return { timestamp, value: parsePromValue(rawValue), ...(sampleTimestamp === undefined ? {} : {
    sampleTimestamp, sampleTimeIso: unixTimeIso(sampleTimestamp),
  }) };
}

async function prometheusFetch(baseUrl: string, path: string, params?: Record<string, string | number>) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url);
  const text = await response.text();
  let payload: PrometheusResponse;
  try {
    payload = JSON.parse(text) as PrometheusResponse;
  } catch {
    throw new Error(`Prometheus returned non-JSON response (${response.status}): ${text.slice(0, 500)}`);
  }
  if (!response.ok || payload.status !== "success") {
    throw new Error(`Prometheus request failed (${response.status}): ${payload.error || text}`);
  }
  return payload;
}

function compactResult(payload: PrometheusResponse, maxSeries: number, maxPoints: number, sampleTimes?: PrometheusResponse, rangeEvaluations = false) {
  const result = payload.data?.result || [];
  return {
    resultType: payload.data?.resultType,
    ...(payload.warnings?.length ? { warnings: payload.warnings } : {}),
    ...(payload.isPartial ? { isPartial: true } : {}),
    seriesCount: result.length,
    result: result.slice(0, maxSeries).map((series) => {
      const clock = sampleTimes?.data?.result.find(item => seriesKey(item.metric) === seriesKey(series.metric));
      const times = new Map((clock?.values || []).map(([time, value]) => [time, Number(value)] as const)
        .filter(([, value]) => unixTimeIso(value) !== null));
      if (series.value) {
        return {
          metric: series.metric,
          value: compactSample(series.value[0], series.value[1]),
        };
      }
      const values = series.values || [];
      // Keep both edges: stride sampling can omit the last observed point,
      // making a data gap appear to begin earlier than the backend evidence.
      const selected = values.length <= maxPoints ? values : maxPoints === 1
        ? [values[0]]
        : Array.from({ length: maxPoints }, (_value, index) =>
          values[Math.floor(index * (values.length - 1) / (maxPoints - 1))]);
      return {
        metric: series.metric,
        pointCount: values.length,
        returnedPointCount: selected.length,
        downsampled: selected.length < values.length,
        ...(rangeEvaluations ? {
          firstEvaluationTimestampIso: unixTimeIso(values[0]?.[0]),
          lastEvaluationTimestampIso: unixTimeIso(values.at(-1)?.[0]),
          sampleTimeStatus: times.size ? "available" : "unavailable",
          firstSampleTimeIso: unixTimeIso(times.get(values[0]?.[0] ?? NaN)),
          lastSampleTimeIso: unixTimeIso(times.get(values.at(-1)?.[0] ?? NaN)),
        } : {}),
        values: selected.map(([timestamp, value]) => compactSample(timestamp, value, times)),
      };
    }),
    truncated: result.length > maxSeries,
  };
}

async function query(baseUrl: string, promql: string, time?: string, maxSeries = 50) {
  const payload = await prometheusFetch(baseUrl, "/api/v1/query", {
    query: promql,
    ...(time ? { time } : {}),
  });
  return compactResult(payload, maxSeries, 1);
}

async function queryRange(baseUrl: string, promql: string, rawParams: Record<string, unknown>) {
  const rangeMinutes = boundedNumber(rawParams.rangeMinutes, 60, 1, 10080);
  const stepSeconds = boundedNumber(rawParams.stepSeconds, 60, 5, 3600);
  const maxSeries = Math.trunc(boundedNumber(rawParams.maxSeries, 20, 1, 200));
  const maxPoints = Math.trunc(boundedNumber(rawParams.maxPoints, 240, 10, 2000));
  const endParam = stringParam(rawParams.end);
  const startParam = stringParam(rawParams.start);
  const end = endParam ? Math.floor(new Date(endParam).getTime() / 1000) : unixSeconds(new Date());
  const start = startParam ? Math.floor(new Date(startParam).getTime() / 1000) : end - Math.floor(rangeMinutes * 60);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error("Invalid time range. Use ISO timestamps for start/end or rangeMinutes.");
  }
  const payload = await prometheusFetch(baseUrl, "/api/v1/query_range", {
    query: promql,
    start,
    end,
    step: stepSeconds,
  });
  const hasSamples = (payload.data?.result || []).some(series => series.value || series.values?.length);
  let sampleTimes: PrometheusResponse | undefined;
  let sampleTimeStatus = "no_samples_in_window";
  if (hasSamples) {
    sampleTimeStatus = "unavailable";
    try {
      const clock = await prometheusFetch(baseUrl, "/api/v1/query_range", {
        query: `timestamp(${promql})`, start, end, step: stepSeconds,
      });
      if (clock.data?.resultType === "matrix" && !clock.isPartial && !clock.warnings?.length &&
          clock.data.result.some(series => series.values?.some(([, value]) => unixTimeIso(Number(value)) !== null))) {
        sampleTimes = clock;
        sampleTimeStatus = "available";
      }
    } catch {
      // Keep successful metric evidence; a failed clock query establishes no sample time.
    }
  }
  return {
    query: promql,
    start,
    end,
    startIso: unixTimeIso(start),
    endIso: unixTimeIso(end),
    stepSeconds,
    queriedDurationMinutes: (end - start) / 60,
    ...compactResult(payload, maxSeries, maxPoints, sampleTimes, true),
    sampleTimeStatus,
    sampleTimestampMeaning: "input_expression_sample_time; original source time for a plain metric selector, potentially derived for computed expressions",
    historyEvidence: {
      status: payload.isPartial || payload.warnings?.length ? "incomplete_response"
        : hasSamples ? "samples_returned" : "no_samples_in_window",
      incidentOnsetDetermined: false,
      timestampMeaning: "query_evaluation_time",
      guidance: hasSamples
        ? "Query boundaries are not incident onset times. To date a gap, find the last present and first missing observations for the same source, then refine that interval. For a plain metric selector use lastSampleTimeIso and sampleTimeIso; timestamp is an evaluation time that can reuse an older sample. Computed expressions may have derived sample clocks; query the original selector to date its source. Unavailable sample-time evidence does not establish an onset. Downsampling can hide intermediate gaps."
        : "No samples in this query window does not establish when data stopped. Search earlier or progressively wider windows for the same metric and exact source labels. Use the original metric selector; populated ranges include sample clocks to refine the last-present/first-missing interval. If history or investigation limits prevent this, report the onset as unknown and state the checked window, not an incident start time.",
    },
  };
}

export default definePluginEntry({
  id: "observability",
  name: "Observability",
  description: "Read-only Prometheus-compatible metrics and Grafana tools for cluster observability.",
  register(api) {
    registerGrafanaTools(api);

    const registerTool = (tool: Parameters<typeof api.registerTool>[0]) => {
      if (isToolEnabled(api.pluginConfig, tool.name)) {
        api.registerTool(tool);
      }
    };

    registerLokiTools(api.pluginConfig, registerTool);
    const baseUrl = resolveBaseUrl(api.pluginConfig);
    if (!baseUrl) return;

    registerTool({
      name: "observability_metric_names",
      label: "Observability Metric Names",
      description: "List available Prometheus or VictoriaMetrics metric names, optionally filtered by substring or regular expression.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          filter: { type: "string", description: "Optional case-insensitive substring or regular expression source." },
          limit: { type: "number", description: "Maximum metric names to return." },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const payload = await prometheusFetch(baseUrl, "/api/v1/label/__name__/values");
        const values = ((payload.data as unknown as string[]) || []) as string[];
        const filter = stringParam(rawParams.filter);
        const limit = Math.trunc(boundedNumber(rawParams.limit, 200, 1, 5000));
        const regex = filter ? new RegExp(filter, "i") : null;
        const names = values
          .filter((name) => !regex || regex.test(name))
          .sort();
        return jsonToolResult({
          source: baseUrl,
          count: names.length,
          returned: Math.min(limit, names.length),
          names: names.slice(0, limit),
        });
      },
    });

    registerTool({
      name: "observability_query",
      label: "Metrics Instant Query",
      description: "Run a read-only instant PromQL or MetricsQL query against the configured metrics service.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "PromQL or MetricsQL instant query supported by the configured backend." },
          time: { type: "string", description: "Evaluation time as RFC3339 or Unix timestamp. Set explicitly for a requested historical investigation time; defaults to now." },
          maxSeries: { type: "number", description: "Maximum returned series." },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const promql = stringParam(rawParams.query);
        if (!promql) throw new Error("query is required");
        const result = await query(
          baseUrl,
          promql,
          stringParam(rawParams.time),
          Math.trunc(boundedNumber(rawParams.maxSeries, 50, 1, 500)),
        );
        return jsonToolResult({ source: baseUrl, query: promql, ...result });
      },
    });

    registerTool({
      name: "observability_range_query",
      label: "Metrics Range Query",
      description: "Run a historical metrics query. For missing-data onset, query the original metric selector with an explicit investigation end and widen earlier history until samples are found. Results include sample clocks; use lastSampleTimeIso, not lastEvaluationTimestampIso. Computed expressions can have derived clocks.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "PromQL or MetricsQL range query supported by the configured backend." },
          rangeMinutes: { type: "number", description: "Lookback window in minutes. Default 60; clamped to 1–10080 (7 days). Use explicit start/end for older windows." },
          stepSeconds: { type: "number", description: "Prometheus step in seconds. Default 60." },
          start: { type: "string", description: "Optional explicit start time." },
          end: { type: "string", description: "Investigation end as an ISO timestamp. Set explicitly for a requested historical or as-of time, including follow-ups; defaults to now." },
          maxSeries: { type: "number", description: "Maximum returned series." },
          maxPoints: { type: "number", description: "Maximum returned points per series after downsampling." },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const promql = stringParam(rawParams.query);
        if (!promql) throw new Error("query is required");
        return jsonToolResult({ source: baseUrl, ...(await queryRange(baseUrl, promql, rawParams)) });
      },
    });
  },
});
