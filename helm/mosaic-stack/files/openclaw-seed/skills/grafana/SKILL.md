---
name: grafana
description: "Create and open Grafana dashboards for metrics, Loki logs, and mixed panels. Use when the user asks for a dashboard, visualization, chart, panel, or graph of GPU, Base Command Manager (BCM), node, network, InfiniBand, Prometheus metrics, or Loki logs."
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

Example PromQL queries; verify metric names and source labels before using them:

- `max by (Hostname, gpu) (DCGM_FI_DEV_GPU_TEMP)`
- `avg by (Hostname) (DCGM_FI_DEV_GPU_UTIL)`
- `avg by (Hostname, gpu) (DCGM_FI_DEV_POWER_USAGE)`
- `rate(bcm_network_receive_bytes_total[5m])`
- `rate(bcm_infiniband_port_data_received_bytes_total[5m])`

## Dashboard authoring and access

Dashboard creation is available in View mode: it saves visualizations without changing monitored workloads or infrastructure. Use the dashboard tools rather than generic execution or asking users to import JSON manually.

Dashboards may mix Prometheus and Loki panels.

1. Discover datasource names, types, and UIDs with `dashboard_list` or
   `grafana_dashboard_presets`. Both return a `datasources` list;
   `dashboard_list` returns it even when its dashboard search has no matches.
   Dashboard UIDs, datasource UIDs, and Loki source labels are different identifiers.
2. Pass `panels` as a JSON array of objects. For each Loki panel, use
   `datasource: {type: "loki", uid: "<discovered UID>"}` and a grounded LogQL
   `query`; use `visualization: "logs"` for raw log lines. Prometheus panels
   accept a discovered datasource or the configured default.
3. If validation fails, inspect its issues and `availableDatasources`. Correct
   the affected UID/type using the returned choices. Do not guess a UID or repeat
   an unchanged failed call. If no suitable datasource exists in that list,
   report the configuration gap.
4. An empty query result describes the selected source and time window. Check
   source labels and timestamps before concluding data is unavailable. When the
   user has not specified a window, check a broader supported window and state
   the range used; preserve explicitly requested incident windows.
5. Create the requested panels and inspect the result. `created: true` confirms
   creation, but success also requires the panels to match the requested sources
   and content. Do not silently substitute unrelated metrics or omit requested
   logs. Report any unavailable part and the evidence for it.

Each panel is validated against its selected datasource and the UI proxy before
saving. A missing datasource and a valid query with no matching data require
different corrections; use the tool's returned evidence to distinguish them.
