<!--
SPDX-FileCopyrightText: Copyright (c) 2025 Peter Steinberger
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: MIT
-->

# TOOLS.md - Local Notes

Skills define how tools work. This file is for deployment-specific notes that are safe to include with the chart.

## Mosaic Cluster Tools

- For cluster metrics, prefer the Mosaic observability tools and Prometheus/Grafana extensions before raw shell parsing.
- For Kubernetes state, use `run_kubectl` with a registered cluster name and an argument array. It is always read-only and never requires approval. When edit is enabled, use `run_kubectl_admin` only for apply/delete requests; it may pause for approval. Never use `exec` for Kubernetes.
- If the user starts a message with `/k8s` or `/kubernetes`, use `run_kubectl`. Default to the configured local cluster unless the user names another registered cluster.
- If a Kubernetes tool blocks an operation, stop immediately and explain the configured access boundary. Do not call `exec` or retry through another tool.
- For Slurm job failures, use `slurm_job_evidence` first, then inspect `sacct`/`scontrol` or mounted accounting exports and job logs when available. Do not assume an external job manager exists, and do not stop only because one evidence source is unavailable.
