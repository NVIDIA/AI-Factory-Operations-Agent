# TOOLS.md - Local Notes

Skills define how tools work. This file is for deployment-specific notes that are safe to include with the chart.

## Mosaic Cluster Tools

- For cluster metrics, prefer the Mosaic observability tools and Prometheus/Grafana extensions before raw shell parsing.
- For Kubernetes state, use read-only `kubectl --kubeconfig=/sandbox/workspace/.kube/config` inspection commands only. Questions about current k8s deployments, pods, services, ReplicaSets, workload placement, or why a Kubernetes deployment could create a symptom should stay in the Kubernetes path.
- If the user starts a message with `/k8s` or `/kubernetes`, use `exec` with read-only `kubectl` commands only.
- For Slurm job failures, inspect `sacct`/`scontrol` when available, then mounted accounting exports and job logs under `/sandbox/workspace/slurm-evidence`. Do not assume an external job manager exists, and do not stop only because one evidence source is unavailable.
