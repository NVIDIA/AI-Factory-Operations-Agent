---
name: observability
description: "Analyze historical Thor cluster state using Prometheus metrics. Use when the user asks about GPU utilization/temperature/power over time, BCM/node/network/InfiniBand trends, metric availability, outages, cluster health history, or what changed in the cluster over a time range."
metadata:
  {
    "openclaw":
      {
        "emoji": "📈",
        "requires": { "tools": ["observability_query", "observability_range_query"] }
      }
  }
---

# observability — Prometheus Cluster History

Use the `observability_*` tools to query the Mosaic observability Prometheus.

Prefer these tools over shell `curl` when answering questions about historical cluster state.

## Useful starting points

- `observability_health` checks whether Prometheus is reachable.
- `observability_metric_names` lists available `DCGM_FI_*` and `bcm_*` metrics.
- `observability_query` runs an instant PromQL query.
- `observability_range_query` runs a historical range query.
- `observability_cluster_summary` returns common GPU, node, network, and InfiniBand summary queries.

## Example PromQL

- `avg by (Hostname) (DCGM_FI_DEV_GPU_UTIL)`
- `max by (Hostname, gpu) (DCGM_FI_DEV_GPU_TEMP)`
- `rate(DCGM_FI_PROF_PCIE_RX_BYTES[5m])`
- `rate(bcm_network_receive_bytes_total[5m])`
- `rate(bcm_infiniband_port_data_received_bytes_total[5m])`
- `bcm_process_count`
