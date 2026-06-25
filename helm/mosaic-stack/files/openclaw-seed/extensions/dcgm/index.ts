import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

type MetricSample = {
  name: string;
  labels: Record<string, string>;
  value: number;
};

type GpuSnapshot = {
  hostname: string;
  gpu: string;
  uuid?: string;
  pciBusId?: string;
  device?: string;
  modelName?: string;
  driverVersion?: string;
  smClockMhz?: number;
  memoryClockMhz?: number;
  gpuTempC?: number;
  memoryTempC?: number;
  gpuUtilPct?: number;
  memoryUtilPct?: number;
  powerUsageW?: number;
  totalEnergyMj?: number;
  pcieReplayCounter?: number;
  pcieRxBytesPerSecond?: number;
  pcieTxBytesPerSecond?: number;
  nvlinkBandwidthTotal?: number;
  xidErrors?: number;
};

const DEFAULT_BASE_URL = "http://nvidia-dcgm-exporter.gpu-operator.svc.cluster.local:9400";

const SUMMARY_METRICS = new Set([
  "DCGM_FI_DEV_SM_CLOCK",
  "DCGM_FI_DEV_MEM_CLOCK",
  "DCGM_FI_DEV_GPU_TEMP",
  "DCGM_FI_DEV_MEMORY_TEMP",
  "DCGM_FI_DEV_GPU_UTIL",
  "DCGM_FI_DEV_MEM_COPY_UTIL",
  "DCGM_FI_DEV_POWER_USAGE",
  "DCGM_FI_DEV_TOTAL_ENERGY_CONSUMPTION",
  "DCGM_FI_DEV_PCIE_REPLAY_COUNTER",
  "DCGM_FI_PROF_PCIE_RX_BYTES",
  "DCGM_FI_PROF_PCIE_TX_BYTES",
  "DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL",
  "DCGM_FI_DEV_XID_ERRORS",
]);

function resolveBaseUrl(pluginConfig: unknown): string {
  if (
    pluginConfig &&
    typeof pluginConfig === "object" &&
    "baseUrl" in pluginConfig &&
    typeof (pluginConfig as { baseUrl?: unknown }).baseUrl === "string"
  ) {
    return ((pluginConfig as { baseUrl: string }).baseUrl || "").replace(/\/+$/, "");
  }
  return DEFAULT_BASE_URL;
}

function jsonToolResult(payload: unknown) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text", text }],
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

async function fetchMetrics(baseUrl: string) {
  const response = await fetch(`${baseUrl}/metrics`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`DCGM exporter request failed (${response.status}): ${text}`);
  }
  return text;
}

function parseLabels(rawLabels: string) {
  const labels: Record<string, string> = {};
  const regex = /([A-Za-z_][A-Za-z0-9_]*)="((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(rawLabels)) !== null) {
    labels[match[1]] = match[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return labels;
}

function parseDcgmMetrics(text: string) {
  const samples: MetricSample[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^([A-Za-z_:][A-Za-z0-9_:]*)(?:\{([^}]*)\})?\s+(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)$/i);
    if (!match) {
      continue;
    }
    samples.push({
      name: match[1],
      labels: parseLabels(match[2] || ""),
      value: Number(match[3]),
    });
  }
  return samples;
}

function setIfFinite(target: GpuSnapshot, key: keyof GpuSnapshot, value: number) {
  if (Number.isFinite(value)) {
    (target as Record<string, unknown>)[key] = value;
  }
}

function summarizeSnapshots(snapshots: GpuSnapshot[]) {
  const warnings: string[] = [];
  for (const gpu of snapshots) {
    if ((gpu.gpuTempC ?? 0) >= 85) {
      warnings.push(`${gpu.hostname} gpu ${gpu.gpu} temperature is ${gpu.gpuTempC}C`);
    }
    if ((gpu.memoryTempC ?? 0) >= 90) {
      warnings.push(`${gpu.hostname} gpu ${gpu.gpu} memory temperature is ${gpu.memoryTempC}C`);
    }
    if ((gpu.pcieReplayCounter ?? 0) > 0) {
      warnings.push(`${gpu.hostname} gpu ${gpu.gpu} has PCIe replay counter ${gpu.pcieReplayCounter}`);
    }
    if ((gpu.xidErrors ?? 0) > 0) {
      warnings.push(`${gpu.hostname} gpu ${gpu.gpu} has XID error value ${gpu.xidErrors}`);
    }
  }

  const hottest = snapshots
    .filter((gpu) => typeof gpu.gpuTempC === "number")
    .sort((a, b) => (b.gpuTempC ?? -Infinity) - (a.gpuTempC ?? -Infinity))[0];
  const busiest = snapshots
    .filter((gpu) => typeof gpu.gpuUtilPct === "number")
    .sort((a, b) => (b.gpuUtilPct ?? -Infinity) - (a.gpuUtilPct ?? -Infinity))[0];
  const highestPower = snapshots
    .filter((gpu) => typeof gpu.powerUsageW === "number")
    .sort((a, b) => (b.powerUsageW ?? -Infinity) - (a.powerUsageW ?? -Infinity))[0];

  return {
    gpuCount: snapshots.length,
    hostCount: new Set(snapshots.map((gpu) => gpu.hostname)).size,
    hottestGpu: hottest
      ? { hostname: hottest.hostname, gpu: hottest.gpu, temperatureC: hottest.gpuTempC }
      : null,
    busiestGpu: busiest
      ? { hostname: busiest.hostname, gpu: busiest.gpu, utilizationPct: busiest.gpuUtilPct }
      : null,
    highestPowerGpu: highestPower
      ? { hostname: highestPower.hostname, gpu: highestPower.gpu, powerW: highestPower.powerUsageW }
      : null,
    idleGpuCount: snapshots.filter((gpu) => (gpu.gpuUtilPct ?? 0) === 0).length,
    warnings,
  };
}

function summarize(samples: MetricSample[]) {
  return summarizeSnapshots(summarizeToSnapshots(samples));
}

function numberParam(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

function stringParam(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export default definePluginEntry({
  id: "dcgm",
  name: "DCGM GPU Metrics",
  description: "Read-only OpenClaw tools for NVIDIA DCGM exporter metrics from the GPU Operator.",
  register(api) {
    const baseUrl = resolveBaseUrl(api.pluginConfig);
    const registerTool = (tool: Parameters<typeof api.registerTool>[0]) => {
      if (isToolEnabled(api.pluginConfig, tool.name)) {
        api.registerTool(tool);
      }
    };

    registerTool({
      name: "dcgm_health",
      label: "DCGM Health",
      description: "Check whether the NVIDIA DCGM exporter service is reachable.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        const metrics = await fetchMetrics(baseUrl);
        const samples = parseDcgmMetrics(metrics);
        return jsonToolResult({
          source: baseUrl,
          reachable: true,
          sampleCount: samples.length,
          dcgmMetricCount: new Set(samples.map((sample) => sample.name).filter((name) => name.startsWith("DCGM_"))).size,
        });
      },
    });

    registerTool({
      name: "dcgm_current",
      label: "DCGM Current Snapshot",
      description: "Return a structured current snapshot of GPU temperature, utilization, power, PCIe, and NVLink metrics.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          hostname: { type: "string", description: "Optional host filter, for example dgx-01." },
          gpu: { type: "string", description: "Optional GPU index filter, for example 0." },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const hostname = stringParam(rawParams.hostname);
        const gpu = stringParam(rawParams.gpu);
        const samples = parseDcgmMetrics(await fetchMetrics(baseUrl));
        const fullSnapshots = summarizeToSnapshots(samples);
        const filtered = fullSnapshots.filter((entry) => {
          if (hostname && entry.hostname !== hostname) return false;
          if (gpu && entry.gpu !== gpu) return false;
          return true;
        });
        return jsonToolResult({
          source: baseUrl,
          timestamp: new Date().toISOString(),
          summary: summarizeSnapshots(filtered),
          gpus: filtered,
        });
      },
    });

    registerTool({
      name: "dcgm_top",
      label: "DCGM Top GPUs",
      description: "Return the top GPUs by temperature, utilization, power draw, replay counter, or NVLink bandwidth.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          metric: {
            type: "string",
            description: "One of temperature, utilization, power, pcie_replay, nvlink_bandwidth.",
          },
          limit: { type: "number", description: "Maximum number of GPUs to return." },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const metric = stringParam(rawParams.metric) || "temperature";
        const limit = Math.max(1, Math.min(64, numberParam(rawParams.limit, 10)));
        const snapshots = summarizeToSnapshots(parseDcgmMetrics(await fetchMetrics(baseUrl)));
        const metricMap: Record<string, keyof GpuSnapshot> = {
          temperature: "gpuTempC",
          utilization: "gpuUtilPct",
          power: "powerUsageW",
          pcie_replay: "pcieReplayCounter",
          nvlink_bandwidth: "nvlinkBandwidthTotal",
        };
        const key = metricMap[metric] || metricMap.temperature;
        return jsonToolResult({
          source: baseUrl,
          metric,
          gpus: snapshots
            .filter((gpu) => typeof gpu[key] === "number")
            .sort((a, b) => Number(b[key] ?? -Infinity) - Number(a[key] ?? -Infinity))
            .slice(0, limit),
        });
      },
    });

    registerTool({
      name: "dcgm_metric_names",
      label: "DCGM Metric Names",
      description: "List available DCGM metric names from the exporter.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          filter: { type: "string", description: "Optional case-insensitive substring filter." },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const filter = stringParam(rawParams.filter)?.toLowerCase();
        const names = Array.from(new Set(parseDcgmMetrics(await fetchMetrics(baseUrl)).map((sample) => sample.name)))
          .filter((name) => !filter || name.toLowerCase().includes(filter))
          .sort();
        return jsonToolResult({ source: baseUrl, count: names.length, names });
      },
    });

    registerTool({
      name: "dcgm_raw_metric",
      label: "DCGM Raw Metric",
      description: "Return raw samples for one DCGM metric, optionally filtered by host or GPU.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["metric"],
        properties: {
          metric: { type: "string", description: "Exact metric name, for example DCGM_FI_DEV_GPU_TEMP." },
          hostname: { type: "string", description: "Optional Hostname label filter." },
          gpu: { type: "string", description: "Optional gpu label filter." },
          limit: { type: "number", description: "Maximum samples to return." },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const metric = stringParam(rawParams.metric);
        if (!metric) throw new Error("metric is required");
        const hostname = stringParam(rawParams.hostname);
        const gpu = stringParam(rawParams.gpu);
        const limit = Math.max(1, Math.min(512, numberParam(rawParams.limit, 128)));
        const samples = parseDcgmMetrics(await fetchMetrics(baseUrl))
          .filter((sample) => sample.name === metric)
          .filter((sample) => !hostname || sample.labels.Hostname === hostname || sample.labels.hostname === hostname)
          .filter((sample) => !gpu || sample.labels.gpu === gpu)
          .slice(0, limit);
        return jsonToolResult({ source: baseUrl, metric, count: samples.length, samples });
      },
    });
  },
});

function summarizeToSnapshots(samples: MetricSample[]) {
  const grouped = new Map<string, GpuSnapshot>();
  for (const sample of samples) {
    if (!SUMMARY_METRICS.has(sample.name)) continue;
    const hostname = sample.labels.Hostname || sample.labels.hostname || "unknown";
    const gpu = sample.labels.gpu || sample.labels.device || sample.labels.UUID || "unknown";
    const key = `${hostname}/${gpu}`;
    const current = grouped.get(key) ?? { hostname, gpu };
    current.uuid = current.uuid || sample.labels.UUID;
    current.pciBusId = current.pciBusId || sample.labels.pci_bus_id;
    current.device = current.device || sample.labels.device;
    current.modelName = current.modelName || sample.labels.modelName;
    current.driverVersion = current.driverVersion || sample.labels.DCGM_FI_DRIVER_VERSION;
    switch (sample.name) {
      case "DCGM_FI_DEV_SM_CLOCK": setIfFinite(current, "smClockMhz", sample.value); break;
      case "DCGM_FI_DEV_MEM_CLOCK": setIfFinite(current, "memoryClockMhz", sample.value); break;
      case "DCGM_FI_DEV_GPU_TEMP": setIfFinite(current, "gpuTempC", sample.value); break;
      case "DCGM_FI_DEV_MEMORY_TEMP": setIfFinite(current, "memoryTempC", sample.value); break;
      case "DCGM_FI_DEV_GPU_UTIL": setIfFinite(current, "gpuUtilPct", sample.value); break;
      case "DCGM_FI_DEV_MEM_COPY_UTIL": setIfFinite(current, "memoryUtilPct", sample.value); break;
      case "DCGM_FI_DEV_POWER_USAGE": setIfFinite(current, "powerUsageW", sample.value); break;
      case "DCGM_FI_DEV_TOTAL_ENERGY_CONSUMPTION": setIfFinite(current, "totalEnergyMj", sample.value); break;
      case "DCGM_FI_DEV_PCIE_REPLAY_COUNTER": setIfFinite(current, "pcieReplayCounter", sample.value); break;
      case "DCGM_FI_PROF_PCIE_RX_BYTES": setIfFinite(current, "pcieRxBytesPerSecond", sample.value); break;
      case "DCGM_FI_PROF_PCIE_TX_BYTES": setIfFinite(current, "pcieTxBytesPerSecond", sample.value); break;
      case "DCGM_FI_DEV_NVLINK_BANDWIDTH_TOTAL": setIfFinite(current, "nvlinkBandwidthTotal", sample.value); break;
      case "DCGM_FI_DEV_XID_ERRORS": setIfFinite(current, "xidErrors", sample.value); break;
    }
    grouped.set(key, current);
  }
  return Array.from(grouped.values()).sort((a, b) => {
    const host = a.hostname.localeCompare(b.hostname);
    if (host !== 0) return host;
    return a.gpu.localeCompare(b.gpu, undefined, { numeric: true });
  });
}
