---
name: grafana
description: "Create and open Grafana dashboards for cluster metrics. Use when the user asks for a dashboard, visualization, chart, panel, or graph of GPU, BCM, node, network, InfiniBand, or Prometheus metrics."
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

Use `grafana_dashboard_create` to build a dashboard from PromQL panels and open it in the Mosaic UI Grafana tab.

Always validate queries before claiming success. The create tool validates each panel and returns actionable errors if a query is invalid or empty.

Useful PromQL examples:

- `max by (Hostname, gpu) (DCGM_FI_DEV_GPU_TEMP)`
- `avg by (Hostname) (DCGM_FI_DEV_GPU_UTIL)`
- `avg by (Hostname, gpu) (DCGM_FI_DEV_POWER_USAGE)`
- `rate(bcm_network_receive_bytes_total[5m])`
- `rate(bcm_infiniband_port_data_received_bytes_total[5m])`
