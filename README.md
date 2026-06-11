# Mosaic

Mosaic is an SRE-facing operations interface for AI factories built around OpenClaw.

## Summary

- OpenClaw runs on Kubernetes as the gateway and execution environment for Mosaic agents.
- Mosaic provides a single UI for chat-based operations, read-only Kubernetes inspection, observability workflows, Grafana dashboard creation, and Slurm log RCA.
- The public deployment is modular and Helm-based; optional integrations are supplied by the target environment.

## Public Capabilities

| Capability | Boundary Condition |
| --- | --- |
| Base deployment | Kubernetes cluster for running Mosaic, OpenClaw, OpenShell gateway, and supporting services. |
| Kubernetes analysis | Kubernetes API access for read-only inspection of pods, nodes, services, deployments, and cluster state. |
| Cluster metrics | Prometheus exporters or equivalent telemetry sources for cluster metrics. |
| Grafana analysis | Access to Grafana, Prometheus, or equivalent observability data sources. |
| Slurm RCA | Mounted Slurm accounting exports and job logs. |

## Quick Start

See [helm/README.md](helm/README.md) for Helm deployment instructions.
