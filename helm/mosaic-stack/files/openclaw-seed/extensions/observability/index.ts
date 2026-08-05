// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
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
  throw new Error("observability.prometheusUrl is required");
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

function compactResult(payload: PrometheusResponse, maxSeries: number, maxPoints: number) {
  const result = payload.data?.result || [];
  return {
    resultType: payload.data?.resultType,
    seriesCount: result.length,
    result: result.slice(0, maxSeries).map((series) => {
      if (series.value) {
        return {
          metric: series.metric,
          value: {
            timestamp: series.value[0],
            value: parsePromValue(series.value[1]),
          },
        };
      }
      const values = series.values || [];
      const stride = Math.max(1, Math.ceil(values.length / maxPoints));
      return {
        metric: series.metric,
        pointCount: values.length,
        values: values
          .filter((_value, index) => index % stride === 0)
          .slice(0, maxPoints)
          .map(([timestamp, value]) => ({ timestamp, value: parsePromValue(value) })),
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
  return {
    query: promql,
    start,
    end,
    stepSeconds,
    ...compactResult(payload, maxSeries, maxPoints),
  };
}

export default definePluginEntry({
  id: "observability",
  name: "Observability",
  description: "Read-only Prometheus and Grafana tools for cluster observability.",
  register(api) {
    registerGrafanaTools(api);

    const baseUrl = resolveBaseUrl(api.pluginConfig);
    const registerTool = (tool: Parameters<typeof api.registerTool>[0]) => {
      if (isToolEnabled(api.pluginConfig, tool.name)) {
        api.registerTool(tool);
      }
    };

    registerTool({
      name: "observability_metric_names",
      label: "Observability Metric Names",
      description: "List available Prometheus metric names, optionally filtered by substring or regular expression.",
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
      label: "Prometheus Instant Query",
      description: "Run a read-only instant PromQL query against observability Prometheus.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "PromQL instant query." },
          time: { type: "string", description: "Optional RFC3339 or Unix timestamp." },
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
      label: "Prometheus Range Query",
      description: "Run a historical PromQL range query.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", description: "PromQL range query." },
          rangeMinutes: { type: "number", description: "Lookback window in minutes. Default 60." },
          stepSeconds: { type: "number", description: "Prometheus step in seconds. Default 60." },
          start: { type: "string", description: "Optional explicit start time." },
          end: { type: "string", description: "Optional explicit end time." },
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
