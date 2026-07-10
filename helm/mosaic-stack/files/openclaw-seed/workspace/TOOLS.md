<!--
SPDX-FileCopyrightText: Copyright (c) 2025 Peter Steinberger
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: MIT
-->

# TOOLS.md - Local Notes

Skills define how tools work. This file is for deployment-specific notes that are safe to include with the chart.

## Mosaic Cluster Tools

- For cluster metrics, prefer the Mosaic observability tools and Prometheus/Grafana extensions before raw shell parsing.
- For Kubernetes state, use `run_kubectl` with a registered cluster name and an argument array. It is always read-only and never requires approval. When edit is enabled, use `run_kubectl_admin` for any exact kubectl operation outside the read-only tool; Edit pauses for approval and Auto does not. Pass standard input through the tool's `stdin` field. Never use general `exec` for Kubernetes.
- If the user starts a message with `/k8s` or `/kubernetes`, use `run_kubectl`. Default to the configured local cluster unless the user names another registered cluster.
- If a Kubernetes tool blocks an operation, give a brief plain-text final response that the action was not performed and explain the configured access boundary. Do not call `exec` or retry through another tool.
- View mode permits a fixed set of read-only diagnostics through local `exec` and configured `run_remote_ssh` targets. Use one simple command or argv array with no shell syntax. Examples include `nvidia-smi`, `ipmitool mc info`, `journalctl -u slurmd -n 100 --no-pager`, `ibstat`, `systemctl status <unit> --no-pager`, and Slurm status commands. Unknown commands and mutating flags require Edit.
- For Slurm job failures, use `slurm_job_evidence` first, then inspect `sacct`/`scontrol` or mounted accounting exports and job logs when available. Do not assume an external job manager exists, and do not stop only because one evidence source is unavailable.
