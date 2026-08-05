// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const DEFAULT_BASE_URL = "http://slurm-evidence-collector:8080";

function baseUrl(pluginConfig: unknown) {
  if (pluginConfig && typeof pluginConfig === "object") {
    const configured = (pluginConfig as { evidenceUrl?: unknown }).evidenceUrl;
    if (typeof configured === "string" && configured.trim()) return configured.replace(/\/+$/, "");
  }
  return (process.env.MOSAIC_SLURM_EVIDENCE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function jsonToolResult(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

async function getJson(url: string) {
  const response = await fetch(url);
  const text = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Slurm evidence collector returned non-JSON (${response.status}): ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`Slurm evidence collector failed (${response.status}): ${text.slice(0, 500)}`);
  return payload;
}

function stringParam(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export default definePluginEntry({
  id: "slurm",
  name: "Slurm Evidence",
  description: "Read-only Slurm and node evidence tools for root-cause analysis.",
  register(api) {
    const collector = baseUrl(api.pluginConfig);

    api.registerTool({
      name: "slurm_job_evidence",
      label: "Slurm Job Evidence",
      description: "Collect bounded read-only evidence for a Slurm job id from sacct/scontrol-equivalent files, Slurm logs, and job output files.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["jobId"],
        properties: {
          jobId: { type: "string", description: "Slurm job id." },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const jobId = stringParam(rawParams.jobId);
        if (!jobId) throw new Error("jobId is required");
        return jsonToolResult(await getJson(`${collector}/slurm/job?id=${encodeURIComponent(jobId)}`));
      },
    });

    api.registerTool({
      name: "node_read_file",
      label: "Node Evidence Read File",
      description: "Read a bounded text snippet from an allowlisted node evidence path.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", description: "Allowlisted host path to read." },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const path = stringParam(rawParams.path);
        if (!path) throw new Error("path is required");
        return jsonToolResult(await getJson(`${collector}/read?path=${encodeURIComponent(path)}`));
      },
    });

    api.registerTool({
      name: "node_grep_files",
      label: "Node Evidence Grep",
      description: "Search allowlisted node evidence files for a pattern and return bounded matching snippets.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["pattern"],
        properties: {
          pattern: { type: "string", description: "Case-insensitive regular expression." },
          root: { type: "string", description: "Optional allowlisted root path. Defaults to all evidence roots." },
        },
      },
      async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
        const pattern = stringParam(rawParams.pattern);
        if (!pattern) throw new Error("pattern is required");
        const root = stringParam(rawParams.root) || "/";
        return jsonToolResult(await getJson(`${collector}/grep?pattern=${encodeURIComponent(pattern)}&root=${encodeURIComponent(root)}`));
      },
    });
  },
});
