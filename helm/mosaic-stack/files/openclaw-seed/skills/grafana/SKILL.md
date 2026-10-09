---
name: grafana
description: "Create and open Grafana dashboards for cluster metrics. Use when the user asks for a dashboard, visualization, chart, panel, or graph of GPU, Base Command Manager (BCM), node, network, InfiniBand, or Prometheus metrics."
metadata:
  {
    "openclaw":
      {
        "emoji": "dashboard",
        "requires": { "tools": ["grafana_dashboard_create", "grafana_dashboard_validate"] }
      }
  }
---

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# grafana — Dashboard Builder

Use `grafana_dashboard_create` to build a dashboard from PromQL and LogQL panels and open it in the UI Grafana tab.

Always validate queries before claiming success. The create tool validates each panel and returns actionable errors if a query is invalid or empty.

Useful PromQL examples:

- `max by (Hostname, gpu) (DCGM_FI_DEV_GPU_TEMP)`
- `avg by (Hostname) (DCGM_FI_DEV_GPU_UTIL)`
- `avg by (Hostname, gpu) (DCGM_FI_DEV_POWER_USAGE)`
- `rate(bcm_network_receive_bytes_total[5m])`
- `rate(bcm_infiniband_port_data_received_bytes_total[5m])`

## Dashboard authoring and access

Dashboard creation is available in View mode: it saves visualizations without changing monitored workloads or infrastructure. Use the dashboard tools rather than generic execution or asking users to import JSON manually.

Dashboards may mix Prometheus and Loki panels. Discover Grafana datasource UIDs through `dashboard_list` or `grafana_dashboard_presets`; do not invent UIDs. For each Loki panel provide `datasource: {type: "loki", uid: "<discovered UID>"}`, a grounded LogQL `query`, and `visualization: "logs"` for log lines. Prometheus panels accept their own datasource or the configured default. Each panel is validated against its selected datasource and the UI proxy before saving. If a datasource is missing, report that configuration gap instead of claiming the dashboard works.
