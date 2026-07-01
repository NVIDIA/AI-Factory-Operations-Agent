---
name: observability
description: "Analyze cluster observability data and create Grafana dashboards. Use when the user asks about metrics, metric availability, cluster health history, dashboards, charts, panels, or visualizations."
metadata:
  {
    "openclaw":
      {
        "emoji": "📈",
        "requires": { "tools": ["observability_query", "observability_range_query", "dashboard_create"] }
      }
  }
---

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# observability — Cluster Metrics and Dashboards

Use the `observability_*` and `dashboard_*` tools for read-only cluster metrics and dashboard creation.

Prefer these tools over shell `curl` when answering questions about historical cluster state.

## Useful starting points

- `observability_metric_names` lists available Prometheus metrics.
- `observability_query` runs an instant PromQL query.
- `observability_range_query` runs a historical range query.
- `dashboard_list` lists existing Grafana dashboards.
- `dashboard_create` validates explicit panel PromQL, creates a Grafana dashboard, and opens it in the Mosaic UI Grafana tab.
- `dashboard_open` opens an existing Grafana dashboard UID in the Mosaic UI Grafana tab.

## Example PromQL

- `avg by (Hostname) (DCGM_FI_DEV_GPU_UTIL)`
- `max by (Hostname, gpu) (DCGM_FI_DEV_GPU_TEMP)`
- `rate(DCGM_FI_PROF_PCIE_RX_BYTES[5m])`

Treat these as examples only. First use `observability_metric_names` when metric
availability or label names are uncertain.

When answering GPU temperature questions, explicitly identify the hottest
Hostname/GPU, compare it against peer GPUs, and call out whether one GPU is
materially hotter than the rest.

When the user asks for a dashboard, provide explicit panel queries, validate the
PromQL first, then create the dashboard. Do not claim dashboard success unless
`dashboard_create` returns `created: true`.
