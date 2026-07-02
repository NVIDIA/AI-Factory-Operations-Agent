<!--
SPDX-FileCopyrightText: Copyright (c) 2025 Peter Steinberger
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: MIT
-->

# TOOLS.md - Local Notes

Skills define how tools work. This file is for deployment-specific notes that are safe to include with the chart.

## Mosaic Cluster Tools

- For cluster metrics, prefer the Mosaic observability tools and Prometheus/Grafana extensions before raw shell parsing.
- For Kubernetes state, first resolve `KC=$(find /sandbox/mosaic-agent-workspace -maxdepth 2 -name kubeconfig | head -1)`, then use read-only `kubectl --kubeconfig="$KC"` inspection commands only. Questions about current k8s deployments, pods, services, ReplicaSets, workload placement, or why a Kubernetes deployment could create a symptom should stay in the Kubernetes path.
- If the user starts a message with `/k8s` or `/kubernetes`, use `exec` with read-only `kubectl` commands only.
- For Slurm job failures, use `slurm_job_evidence` first, then inspect `sacct`/`scontrol` or mounted accounting exports and job logs when available. Do not assume an external job manager exists, and do not stop only because one evidence source is unavailable.
