<!--
SPDX-FileCopyrightText: Copyright (c) 2025 Peter Steinberger
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: MIT
-->

# TOOLS.md - Local Notes

Skills define how tools work. This file is for deployment-specific notes that are safe to include with the chart.

## Cluster Tools

- For cluster metrics, prefer the observability tools and Prometheus/Grafana extensions before raw shell parsing.
- For Kubernetes state, use `run_kubectl` with a registered cluster name and an argument array. It is always read-only and never requires approval. When edit is enabled, use `run_kubectl_admin` for any exact kubectl operation outside the read-only tool; Edit pauses for approval and Auto does not. Pass standard input through the tool's `stdin` field. Never use general `exec` for Kubernetes.
- In Edit or Auto, `run_kubectl_admin` also accepts `--kubeconfig PATH` or `--kubeconfig=PATH` for reads and changes. The file must be available in the gateway container, where kubectl runs. Its connection settings replace the registered cluster defaults. For a host-local kubeconfig, use `run_remote_ssh` on the configured host and pass its existing path to kubectl. Use `config view` for redacted metadata and the same path for cluster operations. Return operation results rather than moving credential contents between execution environments. SSH approvals and host restrictions still apply.
- If the user starts a message with `/k8s` or `/kubernetes`, use `run_kubectl`. Default to the configured local cluster unless the user names another registered cluster.
- If a Kubernetes tool blocks an operation, give a brief plain-text final response that the action was not performed and explain the configured access boundary. Do not call `exec` or retry through another tool.
- Local `exec` runs in OpenShell in every mode. The sandbox enforces local execution boundaries, including for scripts and shell pipelines.
- `run_remote_ssh` operates outside the sandbox on configured hosts. View permits its read-only diagnostic argv; other remote operations require Edit.
- For Slurm job failures, use `slurm_job_evidence` first, then inspect `sacct`/`scontrol` or mounted accounting exports and job logs when available. Do not assume an external job manager exists, and do not stop only because one evidence source is unavailable.
