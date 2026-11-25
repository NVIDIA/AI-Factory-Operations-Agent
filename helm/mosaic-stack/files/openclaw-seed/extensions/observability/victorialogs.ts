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
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

export function registerVictoriaLogsTools(config: unknown, register: (tool: Tool) => void) {
  const settings = (config ?? {}) as Params;
  const base = text(settings.victoriaLogsUrl);
  if (!base) return;
  const endpoint = new URL(base);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("victoriaLogsUrl must be an HTTP(S) base URL without credentials, query, or fragment");
  }
  const headers: Record<string, string> = { Accept: "application/json, application/stream+json" };
  if (process.env.MOSAIC_VICTORIALOGS_AUTHORIZATION) headers.Authorization = process.env.MOSAIC_VICTORIALOGS_AUTHORIZATION;
  for (const [key, header] of [["victoriaLogsAccountId", "AccountID"], ["victoriaLogsProjectId", "ProjectID"]]) {
    const value = text(settings[key]);
    if (value) {
      if (!Number.isSafeInteger(Number(value)) || Number(value) < 0 || Number(value) > 4294967295 || String(Number(value)) !== value) {
        throw new Error(`${key} must be an unsigned 32-bit integer`);
      }
      headers[header] = value;
    }
  }

  async function request(path: string, params: Record<string, string>) {
    const url = new URL(`${base.endsWith("/") ? base.slice(0, -1) : base}/select/logsql/${path}`);
    url.search = new URLSearchParams(params).toString();
    const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`VictoriaLogs request failed (HTTP ${response.status})`);
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body!) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw new Error("VictoriaLogs response exceeds 2 MiB; narrow the query or time range");
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf8");
    try {
      return path === "query" ? body.split("\n").filter(line => line.trim()).map(line => JSON.parse(line)) : JSON.parse(body);
    } catch { throw new Error("VictoriaLogs returned invalid JSON"); }
  }

  const properties = {
    query: { type: "string", description: "LogsQL expression. Discover fields and values before selecting a source. Field discovery defaults to *." },
    start: { type: "string", description: "ISO 8601 start; defaults to one hour before end. Maximum window 24 hours." },
    end: { type: "string", description: "ISO 8601 end; defaults to now." },
    limit: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum returned rows or fields; default 100." },
  };
  for (const discovery of [true, false]) {
    register({
      name: discovery ? "observability_victorialogs_fields" : "observability_victorialogs_query",
      label: discovery ? "VictoriaLogs Fields" : "VictoriaLogs Query",
      description: discovery
        ? "Discover VictoriaLogs field names or a field's values, with hit counts. Read-only."
        : "Run read-only LogsQL against VictoriaLogs. Returns JSON rows with original fields, timestamps, or aggregation results. The row limit also applies to aggregates; narrow or group the query when limitReached is true.",
      parameters: { type: "object", additionalProperties: false, ...(discovery ? {} : { required: ["query"] }), properties: {
        ...properties,
        ...(discovery ? { field: { type: "string", description: "Discovered field name; omit to list names." } } : {}),
      } },
      async execute(_id, params) {
        const query = text(params.query) || (discovery && params.query === undefined ? "*" : "");
        if (!query || query.length > 8192) throw new Error("query must contain 1–8192 characters");
        const limit = params.limit === undefined ? 100 : params.limit;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be an integer between 1 and 1000");
        const end = params.end === undefined ? Date.now() : Date.parse(text(params.end));
        const start = params.start === undefined ? end - 3600000 : Date.parse(text(params.start));
        if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 86400000) {
          throw new Error("Provide valid start/end timestamps with a positive range of at most 24 hours");
        }
        const window = { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
        const field = text(params.field);
        const data = await request(discovery ? (field ? "field_values" : "field_names") : "query", {
          ...window, query, limit: String(limit), ...(discovery && field ? { field } : {}),
        });
        const rows = discovery ? data?.values : data;
        if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("Invalid VictoriaLogs result");
        const payload = { source: base, query, ...window, ...(field ? { field } : {}),
          [discovery ? "values" : "rows"]: rows.slice(0, limit), returned: Math.min(rows.length, limit), limitReached: rows.length >= limit };
        return { content: [{ type: "text", text: JSON.stringify(payload) }], details: payload };
      },
    });
  }
}
