// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { Buffer } from "node:buffer";

type Params = Record<string, unknown>;
type Tool = {
  name: string;
  label: string;
  description: string;
  parameters: object;
  execute: (id: string, params: Params) => Promise<unknown>;
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function limit(value: unknown): number {
  if (value === undefined) return 100;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error("limit must be an integer between 1 and 1000");
  }
  return value;
}

function windowParams(params: Params) {
  const end = params.end === undefined ? Date.now() : Date.parse(text(params.end));
  const start = params.start === undefined ? end - 3600000 : Date.parse(text(params.start));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 86400000) {
    throw new Error("Provide valid start/end timestamps with a positive range of at most 24 hours");
  }
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

export function registerLokiTools(config: unknown, register: (tool: Tool) => void) {
  const settings = (config ?? {}) as Params;
  const base = text(settings.lokiUrl);
  if (!base) return;
  const endpoint = new URL(base);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("lokiUrl must be an HTTP(S) base URL without credentials, query, or fragment");
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  const authorization = process.env.MOSAIC_LOKI_AUTHORIZATION;
  if (authorization) headers.Authorization = authorization;
  const tenant = text(settings.lokiTenantId);
  if (tenant) headers["X-Scope-OrgID"] = tenant;

  async function request(path: string, params: Record<string, string>) {
    const url = new URL(`${(base.endsWith("/") ? base.slice(0, -1) : base)}/loki/api/v1/${path}`);
    url.search = new URLSearchParams(params).toString();
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Loki request failed (HTTP ${response.status})`);
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body!) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw new Error("Loki response exceeds 2 MiB; narrow the query or time range");
      chunks.push(chunk);
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("Loki returned invalid JSON"); }
    if (payload.status !== "success") throw new Error("Loki query failed");
    return payload.data;
  }

  const properties = {
    start: { type: "string", description: "ISO 8601 start time; defaults to one hour before end. Maximum window 24 hours." },
    end: { type: "string", description: "ISO 8601 end time; defaults to now." },
    limit: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum returned labels or log entries; default 100." },
  };
  function result(payload: object) {
    return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
  }

  register({
    name: "observability_log_labels",
    label: "Loki Log Labels",
    description: "Discover log labels, or values for one label, in the configured Loki tenant. To identify available sources, first list label names, then request values for relevant discovered labels. Names alone do not identify sources. Read-only.",
    parameters: { type: "object", additionalProperties: false, properties: {
      ...properties,
      label: { type: "string", description: "Omit to list label names; provide a discovered name to list its values." },
    } },
    async execute(_id, params) {
      const count = limit(params.limit);
      const label = text(params.label);
      // Encode the entire label as one path component; never accept a caller-provided URL.
      if (label === "." || label === "..") throw new Error("Invalid label name");
      const values = await request(label ? `label/${encodeURIComponent(label)}/values` : "labels", windowParams(params));
      if (!Array.isArray(values) || values.some(value => typeof value !== "string")) throw new Error("Invalid Loki labels response");
      return result({ source: base, label: label || undefined, values: values.slice(0, count), truncated: values.length > count });
    },
  });

  register({
    name: "observability_logs",
    label: "Loki Log Query",
    description: "Run a read-only LogQL log query over a bounded time range. Returns timestamped log streams; metric queries are not supported.",
    parameters: { type: "object", additionalProperties: false, required: ["query"], properties: {
      ...properties,
      query: { type: "string", description: "LogQL stream selector and optional log pipeline. Discover label values before selecting a source. Loki requires at least one label matcher that cannot match an empty value. Preserve the requested source filters when adding an error filter or changing the time window." },
      direction: { type: "string", enum: ["backward", "forward"], description: "Newest first by default." },
    } },
    async execute(_id, params) {
      const query = text(params.query);
      if (!query || query.length > 8192) throw new Error("query must contain 1–8192 characters");
      const count = limit(params.limit);
      const direction = params.direction ?? "backward";
      if (direction !== "backward" && direction !== "forward") throw new Error("Invalid direction");
      const window = windowParams(params);
      const data = await request("query_range", { ...window, query, direction, limit: String(count) });
      if (data?.resultType !== "streams" || !Array.isArray(data.result)) throw new Error("Expected Loki log streams; use a log selector/pipeline rather than a metric query");
      let remaining = count;
      const streams = data.result.map((stream: { stream: Record<string, string>; values: unknown[] }) => {
        const values = stream.values.slice(0, remaining);
        remaining -= values.length;
        return { labels: stream.stream, entries: values };
      }).filter((stream: { entries: unknown[] }) => stream.entries.length);
      return result({ source: base, query, ...window, direction, streams, returned: count - remaining, limitReached: remaining === 0 });
    },
  });
}
