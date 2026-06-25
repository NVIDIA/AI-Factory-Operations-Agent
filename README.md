# Mosaic

Mosaic is an SRE-facing operations interface for AI factories built around OpenClaw.

## Summary

- OpenClaw runs on Kubernetes as the gateway and execution environment for Mosaic agents.
- Mosaic provides a single UI for chat-based operations, read-only Kubernetes inspection, observability workflows, Grafana dashboard creation, and Slurm log RCA.
- Mosaic also exposes headless HTTP, CLI, and MCP entrypoints for the same agent workflows.
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

## Headless Mode

After deployment, Mosaic can be invoked without the UI:

```bash
mosaic "summarize whether the cluster is healthy"
```

The command calls the Mosaic service configured by `MOSAIC_URL` and uses the same OpenClaw-backed agents as the browser UI. Agent clients can run `mosaic-mcp` as a stdio MCP server; it exposes `mosaic_chat`, `mosaic_history`, `mosaic_commands`, and the deployed Mosaic/OpenClaw tools such as BCM, Kubernetes, observability, and Slurm when those modules are enabled. See [docs/skills/mosaic-headless/SKILL.md](docs/skills/mosaic-headless/SKILL.md) for Codex MCP setup and port-forward options.
