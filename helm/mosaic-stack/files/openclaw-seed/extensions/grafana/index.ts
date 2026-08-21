// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

declare const Buffer: { from(value: string): { toString(encoding: string): string } };

type PanelSpec = {
  title: string;
  query: string;
  unit?: string;
  visualization?: "timeseries" | "stat" | "gauge" | "table";
  legend?: string;
  description?: string;
};

type ValidationIssue = {
  panelTitle: string;
  query: string;
  severity: "error" | "warning";
  message: string;
};

const DEFAULT_UI_URL = "http://mosaic-ui:3000";
const GRAFANA_PROXY_PREFIX = "/api/grafana/proxy";

const PRESETS: Record<string, PanelSpec[]> = {
  gpu_temperature: [
    { title: "GPU Temperature by GPU", query: "max by (Hostname, gpu) (DCGM_FI_DEV_GPU_TEMP)", unit: "celsius" },
    { title: "GPU Memory Temperature by GPU", query: "max by (Hostname, gpu) (DCGM_FI_DEV_MEMORY_TEMP)", unit: "celsius" },
  ],
  gpu_utilization: [
    { title: "GPU Utilization by Host", query: "avg by (Hostname) (DCGM_FI_DEV_GPU_UTIL)", unit: "percent" },
    { title: "GPU Utilization by GPU", query: "avg by (Hostname, gpu) (DCGM_FI_DEV_GPU_UTIL)", unit: "percent" },
    { title: "Memory Copy Utilization", query: "avg by (Hostname, gpu) (DCGM_FI_DEV_MEM_COPY_UTIL)", unit: "percent" },
  ],
  gpu_power: [
    { title: "GPU Power Usage", query: "avg by (Hostname, gpu) (DCGM_FI_DEV_POWER_USAGE)", unit: "watt" },
    { title: "GPU Energy Consumption", query: "max by (Hostname, gpu) (DCGM_FI_DEV_TOTAL_ENERGY_CONSUMPTION)", unit: "none" },
  ],
  gpu_pcie_nvlink: [
    { title: "PCIe RX Bytes", query: "rate(DCGM_FI_PROF_PCIE_RX_BYTES[5m])", unit: "Bps" },
    { title: "PCIe TX Bytes", query: "rate(DCGM_FI_PROF_PCIE_TX_BYTES[5m])", unit: "Bps" },
    { title: "NVLink Bandwidth", query: "max by (Hostname, gpu) (DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL)", unit: "none" },
    { title: "PCIe Replay Counter", query: "max by (Hostname, gpu) (DCGM_FI_DEV_PCIE_REPLAY_COUNTER)", unit: "none" },
  ],
  network: [
    { title: "Network Receive Bytes", query: "rate(bcm_network_receive_bytes_total[5m])", unit: "Bps" },
    { title: "Network Transmit Bytes", query: "rate(bcm_network_transmit_bytes_total[5m])", unit: "Bps" },
    { title: "Network Error Rate", query: "rate(bcm_network_receive_errors_total[5m]) + rate(bcm_network_transmit_errors_total[5m])", unit: "ops" },
    { title: "Network Drop Rate", query: "rate(bcm_network_receive_dropped_total[5m]) + rate(bcm_network_transmit_dropped_total[5m])", unit: "ops" },
  ],
  infiniband: [
    { title: "InfiniBand Receive Bytes", query: "rate(bcm_infiniband_port_data_received_bytes_total[5m])", unit: "Bps" },
    { title: "InfiniBand Transmit Bytes", query: "rate(bcm_infiniband_port_data_transmitted_bytes_total[5m])", unit: "Bps" },
    { title: "InfiniBand Receive Errors", query: "rate(bcm_infiniband_port_receive_errors_total[5m])", unit: "ops" },
    { title: "InfiniBand Transmit Discards", query: "rate(bcm_infiniband_port_transmit_discards_total[5m])", unit: "ops" },
  ],
  bcm_health: [
    { title: "BCM Exporter Up", query: "bcm_exporter_up", unit: "none", visualization: "stat" },
    { title: "BCM CMD Installed", query: "bcm_cmd_installed", unit: "none", visualization: "stat" },
    { title: "BCM Metric Scripts Present", query: "bcm_metric_script_present", unit: "none", visualization: "table" },
    { title: "BCM Process Counts", query: "bcm_process_count", unit: "none", visualization: "table" },
  ],
};

function resolveString(pluginConfig: unknown, key: string, fallback?: string) {
  if (
    pluginConfig &&
    typeof pluginConfig === "object" &&
    key in pluginConfig &&
    typeof (pluginConfig as Record<string, unknown>)[key] === "string"
  ) {
    const value = String((pluginConfig as Record<string, unknown>)[key] || "").trim();
    if (value) return value.replace(/\/+$/, "");
  }
  if (fallback) return fallback;
  throw new Error(`grafana.${key} is required`);
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

function boolParam(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizePanel(raw: unknown, index: number): PanelSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const query = stringParam(value.query);
  if (!query) return null;
  return {
    title: stringParam(value.title) || `Panel ${index + 1}`,
    query,
    unit: stringParam(value.unit),
    visualization: (stringParam(value.visualization) as PanelSpec["visualization"]) || "timeseries",
    legend: stringParam(value.legend),
    description: stringParam(value.description),
  };
}

function panelsFromParams(rawParams: Record<string, unknown>) {
  const explicitPanels = Array.isArray(rawParams.panels)
    ? rawParams.panels.map(normalizePanel).filter((panel): panel is PanelSpec => Boolean(panel))
    : [];
  const preset = stringParam(rawParams.preset);
  const presetPanels = preset && PRESETS[preset] ? PRESETS[preset] : [];
  return explicitPanels.length > 0 ? explicitPanels : presetPanels;
}

async function fetchJson(url: string, options?: RequestInit) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(payload).slice(0, 1000)}`);
  }
  return payload as Record<string, unknown>;
}

function buildGrafanaQueryPayload(panel: PanelSpec, rangeMinutes: number, datasourceUid: string) {
  return {
    queries: [
      {
        refId: "A",
        datasource: { type: "prometheus", uid: datasourceUid },
        expr: panel.query,
        range: true,
        instant: false,
        intervalMs: 15000,
        maxDataPoints: 600,
      },
    ],
    from: `now-${Math.max(1, Math.trunc(rangeMinutes))}m`,
    to: "now",
  };
}

function grafanaFrameCount(payload: Record<string, unknown>) {
  const results = payload.results as Record<string, unknown> | undefined;
  const first = results?.A as Record<string, unknown> | undefined;
  const frames = Array.isArray(first?.frames) ? first.frames : [];
  return frames.length;
}

function authHeaders(pluginConfig: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = stringParam((pluginConfig as Record<string, unknown> | undefined)?.token);
  const user = stringParam((pluginConfig as Record<string, unknown> | undefined)?.basicUser);
  const password = stringParam((pluginConfig as Record<string, unknown> | undefined)?.basicPassword);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  } else if (user && password) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  }
  return headers;
}

function uiAuthHeaders() {
  const token = process.env.MOSAIC_UI_MACHINE_TOKEN || "";
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function validatePanels(
  prometheusUrl: string,
  grafanaUrl: string,
  uiUrl: string,
  headers: Record<string, string>,
  datasourceUid: string,
  panels: PanelSpec[],
  requireData: boolean,
  rangeMinutes: number,
) {
  const issues: ValidationIssue[] = [];
  const results: Array<{ title: string; query: string; seriesCount: number; grafanaFrameCount: number; sample?: unknown }> = [];

  for (const panel of panels) {
    const url = new URL(`${prometheusUrl}/api/v1/query`);
    url.searchParams.set("query", panel.query);
    try {
      const payload = await fetchJson(url.toString());
      const data = payload.data as { result?: unknown[] } | undefined;
      const result = Array.isArray(data?.result) ? data.result : [];
      if (requireData && result.length === 0) {
        issues.push({
          panelTitle: panel.title,
          query: panel.query,
          severity: "error",
          message: "Query is valid but returned no series. Adjust the metric name, labels, or time window.",
        });
      }
      let frameCount = 0;
      try {
        const grafanaPayload = await fetchJson(`${grafanaUrl}/api/ds/query`, {
          method: "POST",
          headers,
          body: JSON.stringify(buildGrafanaQueryPayload(panel, rangeMinutes, datasourceUid)),
        });
        frameCount = grafanaFrameCount(grafanaPayload);
        if (requireData && frameCount === 0) {
          issues.push({
            panelTitle: panel.title,
            query: panel.query,
            severity: "error",
            message: "Grafana datasource query returned no data frames. The panel would render empty.",
          });
        }
      } catch (error) {
        issues.push({
          panelTitle: panel.title,
          query: panel.query,
          severity: "error",
          message: `Grafana datasource validation failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      try {
        const uiProxyPayload = await fetchJson(`${uiUrl}/api/grafana/proxy/api/ds/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Origin": uiUrl },
          body: JSON.stringify(buildGrafanaQueryPayload(panel, rangeMinutes, datasourceUid)),
        });
        const uiFrameCount = grafanaFrameCount(uiProxyPayload);
        if (requireData && uiFrameCount === 0) {
          issues.push({
            panelTitle: panel.title,
            query: panel.query,
            severity: "error",
            message: "The frontend Grafana proxy returned no data frames. The iframe panel would render empty.",
          });
        }
      } catch (error) {
        issues.push({
          panelTitle: panel.title,
          query: panel.query,
          severity: "error",
          message: `Frontend Grafana proxy validation failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      results.push({ title: panel.title, query: panel.query, seriesCount: result.length, grafanaFrameCount: frameCount, sample: result[0] });
    } catch (error) {
      issues.push({
        panelTitle: panel.title,
        query: panel.query,
        severity: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ok: issues.filter((issue) => issue.severity === "error").length === 0,
    issues,
    results,
  };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "mosaic-dashboard";
}

function pathFromGrafanaUrl(value: string) {
  if (!value) return "/";
  if (value.startsWith("http://") || value.startsWith("https://")) {
    const parsed = new URL(value);
    return `${parsed.pathname}${parsed.search}`;
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function ensureGrafanaSubPath(path: string) {
  return path.startsWith(GRAFANA_PROXY_PREFIX) ? path : `${GRAFANA_PROXY_PREFIX}${path}`;
}

function appendTimeRange(path: string, rangeMinutes: number) {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}orgId=1&from=now-${Math.trunc(rangeMinutes)}m&to=now&kiosk`;
}

function buildPanel(panel: PanelSpec, index: number, datasourceUid: string) {
  const type = panel.visualization || "timeseries";
  const width = type === "stat" || type === "gauge" ? 6 : 12;
  return {
    id: index + 1,
    type,
    title: panel.title,
    description: panel.description,
    datasource: { type: "prometheus", uid: datasourceUid },
    gridPos: {
      h: type === "stat" || type === "gauge" ? 6 : 8,
      w: width,
      x: (index % Math.floor(24 / width)) * width,
      y: Math.floor(index / Math.floor(24 / width)) * 8,
    },
    targets: [
      {
        refId: "A",
        expr: panel.query,
        range: true,
        legendFormat: panel.legend || "{{Hostname}} {{gpu}} {{node}} {{device}} {{port}}",
      },
    ],
    fieldConfig: {
      defaults: {
        unit: panel.unit || "none",
      },
      overrides: [],
    },
    options: {
      legend: { displayMode: "list", placement: "bottom" },
      tooltip: { mode: "multi", sort: "none" },
    },
  };
}

function buildDashboard(title: string, panels: PanelSpec[], datasourceUid: string, rangeMinutes: number) {
  return {
    id: null,
    uid: `mosaic-${Date.now().toString(36)}`,
    title,
    tags: ["mosaic", "openclaw-generated"],
    timezone: "browser",
    schemaVersion: 42,
    version: 0,
    refresh: "15s",
    time: {
      from: `now-${Math.max(1, Math.trunc(rangeMinutes))}m`,
      to: "now",
    },
    panels: panels.map((panel, index) => buildPanel(panel, index, datasourceUid)),
  };
}

export default definePluginEntry({
  id: "grafana",
  name: "Grafana Dashboard Builder",
  description: "Create, validate, and open Grafana dashboards backed by observability Prometheus.",
  register(api) {
    const grafanaUrl = resolveString(api.pluginConfig, "grafanaUrl");
    const prometheusUrl = resolveString(api.pluginConfig, "prometheusUrl");
    const uiUrl = resolveString(api.pluginConfig, "uiUrl", DEFAULT_UI_URL);
    const datasourceUid = resolveString(api.pluginConfig, "datasourceUid");
    const headers = authHeaders(api.pluginConfig);
    const registerTool = (tool: Parameters<typeof api.registerTool>[0]) => {
      if (isToolEnabled(api.pluginConfig, tool.name)) {
        api.registerTool(tool);
      }
    };

    registerTool({
      name: "grafana_dashboard_health",
      label: "Grafana Dashboard Health",
      description: "Check Grafana, Prometheus, and UI dashboard notification endpoints.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        const [grafanaHealth, prometheusHealth, uiHealth] = await Promise.allSettled([
          fetchJson(`${grafanaUrl}/api/health`, { headers }),
          fetchJson(`${prometheusUrl}/api/v1/query?query=up`),
          fetchJson(`${uiUrl}/api/composer/status`),
        ]);
        return jsonToolResult({
          grafanaUrl,
          prometheusUrl,
          uiUrl,
          grafana: grafanaHealth.status === "fulfilled" ? grafanaHealth.value : { error: String(grafanaHealth.reason) },
          prometheus: prometheusHealth.status === "fulfilled" ? { ok: true } : { error: String(prometheusHealth.reason) },
          ui: uiHealth.status === "fulfilled" ? { ok: true } : { error: String(uiHealth.reason) },
        });
      },
    });

    registerTool({
      name: "grafana_dashboard_presets",
      label: "Grafana Dashboard Presets",
      description: "List dashboard presets the agent can use as starting points.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        return jsonToolResult({ presets: PRESETS });
      },
    });

    registerTool({
      name: "grafana_dashboard_validate",
      label: "Validate Grafana Dashboard Queries",
      description: "Validate dashboard panel PromQL against observability Prometheus before creating a dashboard.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          preset: { type: "string", description: `Optional preset: ${Object.keys(PRESETS).join(", ")}.` },
          panels: {
            type: "array",
            description: "Panel specs with title/query/unit/visualization.",
            items: { type: "object" },
          },
          requireData: { type: "boolean", description: "If true, empty query results are validation errors. Default true." },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const panels = panelsFromParams(rawParams);
        if (panels.length === 0) {
          throw new Error("Provide panels or a known preset.");
        }
        const validation = await validatePanels(
          prometheusUrl,
          grafanaUrl,
          uiUrl,
          headers,
          datasourceUid,
          panels,
          boolParam(rawParams.requireData, true),
          Math.max(1, Math.min(10080, numberParam(rawParams.rangeMinutes, 60))),
        );
        return jsonToolResult({ prometheusUrl, panelCount: panels.length, ...validation });
      },
    });

    registerTool({
      name: "grafana_dashboard_create",
      label: "Create Grafana Dashboard",
      description: "Create a Grafana dashboard after validating every panel query, then open it in the UI Grafana tab.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "Dashboard title." },
          preset: { type: "string", description: `Optional preset: ${Object.keys(PRESETS).join(", ")}.` },
          panels: {
            type: "array",
            description: "Panel specs with title/query/unit/visualization.",
            items: { type: "object" },
          },
          rangeMinutes: { type: "number", description: "Dashboard time range in minutes. Default 60." },
          requireData: { type: "boolean", description: "If true, do not create when any query returns no data. Default true." },
          openInUi: { type: "boolean", description: "If true, switch the UI to Grafana after creation. Default true." },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const title = stringParam(rawParams.title) || "Generated Dashboard";
        const panels = panelsFromParams(rawParams);
        if (panels.length === 0) {
          throw new Error("Provide panels or a known preset.");
        }

        const requireData = boolParam(rawParams.requireData, true);
        const rangeMinutes = Math.max(1, Math.min(10080, numberParam(rawParams.rangeMinutes, 60)));
        const validation = await validatePanels(prometheusUrl, grafanaUrl, uiUrl, headers, datasourceUid, panels, requireData, rangeMinutes);
        if (!validation.ok) {
          return jsonToolResult({
            created: false,
            reason: "Dashboard validation failed. Fix the panel queries and call grafana_dashboard_create again.",
            validation,
          });
        }

        const dashboard = buildDashboard(title, panels, datasourceUid, rangeMinutes);
        const createPayload = await fetchJson(`${grafanaUrl}/api/dashboards/db`, {
          method: "POST",
          headers,
          body: JSON.stringify({ dashboard, folderId: 0, overwrite: true, message: "Created by OpenClaw dashboard plugin" }),
        });

        const uid = stringParam(createPayload.uid) || stringParam((dashboard as Record<string, unknown>).uid) || "";
        const url = stringParam(createPayload.url) || `/d/${uid}/${slugify(title)}`;
        const grafanaPath = ensureGrafanaSubPath(pathFromGrafanaUrl(url));
        const iframeUrl = appendTimeRange(grafanaPath, rangeMinutes);
        const dashboardUrl = `${grafanaUrl}${grafanaPath}`;
        let uiNotification: unknown = null;

        if (boolParam(rawParams.openInUi, true)) {
          try {
            uiNotification = await fetchJson(`${uiUrl}/api/ui/actions`, {
              method: "POST",
              headers: uiAuthHeaders(),
              body: JSON.stringify({
                type: "open_grafana",
                title,
                iframeUrl,
                dashboardUid: uid,
                dashboardUrl,
              }),
            });
          } catch (error) {
            uiNotification = { error: error instanceof Error ? error.message : String(error) };
          }
        }

        return jsonToolResult({
          created: true,
          title,
          uid,
          grafanaUrl,
          dashboardUrl,
          iframeUrl,
          validation,
          uiNotification,
        });
      },
    });

    registerTool({
      name: "grafana_dashboard_open",
      label: "Open Grafana Dashboard",
      description: "Open an existing Grafana dashboard UID in the UI Grafana tab.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["uid"],
        properties: {
          uid: { type: "string", description: "Grafana dashboard UID." },
          title: { type: "string", description: "Dashboard title." },
          rangeMinutes: { type: "number", description: "Dashboard lookback in minutes. Default 60." },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const uid = stringParam(rawParams.uid);
        if (!uid) throw new Error("uid is required");
        const title = stringParam(rawParams.title) || uid;
        const rangeMinutes = Math.max(1, Math.min(10080, numberParam(rawParams.rangeMinutes, 60)));
        const path = ensureGrafanaSubPath(`/d/${uid}/${slugify(title)}`);
        const iframeUrl = appendTimeRange(path, rangeMinutes);
        const uiNotification = await fetchJson(`${uiUrl}/api/ui/actions`, {
          method: "POST",
          headers: uiAuthHeaders(),
          body: JSON.stringify({
            type: "open_grafana",
            title,
            iframeUrl,
            dashboardUid: uid,
            dashboardUrl: `${grafanaUrl}${path}`,
          }),
        });
        return jsonToolResult({ opened: true, uid, iframeUrl, uiNotification });
      },
    });
  },
});
