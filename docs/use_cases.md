# Mosaic Use Cases

## Tenant

### Use Case 1. Failed Slurm Training Job RCA
Summary: A tenant training run exits unexpectedly and the user needs to understand whether the failure came from application code, data, infrastructure, or scheduler state.
Problem: A Slurm job failed with a non-zero exit code, but the raw logs and Slurm history are hard to interpret quickly.
Action: Mosaic invokes the Job Recovery Agent, reads mounted Slurm accounting exports and associated job logs, identifies the likely root cause, and recommends a concrete next action such as fixing a missing dataset manifest or rerunning after correcting the input path.

### Use Case 2. Workload GPU Utilization Check
Summary: A tenant wants to know whether their inference or training workload is using allocated GPUs effectively.
Problem: The workload is running, but throughput is lower than expected and the tenant does not know whether GPUs are idle, overloaded, or unevenly used.
Action: Mosaic queries observability metrics, summarizes GPU utilization across the relevant nodes or pods, and highlights whether one GPU is doing most of the work while others are idle.

### Use Case 3. Workload-Level Kubernetes Inspection
Summary: A tenant needs to understand how their Kubernetes deployment is configured without receiving broad cluster-admin access.
Problem: A model serving deployment may be under-requesting GPUs, using an unexpected namespace, or missing workload-specific configuration.
Action: Mosaic uses the Kubernetes Agent with tenant-appropriate read access to inspect pods, deployments, services, logs, and config maps, then explains how the workload configuration could affect performance or reliability.

### Use Case 4. Safe Remediation Planning
Summary: A tenant wants an operationally safe plan before changing a serving deployment.
Problem: The user knows a deployment is inefficient but wants to avoid creating GPU-consuming pods or making destructive changes while planning.
Action: Mosaic combines Kubernetes evidence, observability context, and Slurm workload state to draft a safe plan and read-only verification steps before any rollout.

### Use Case 5. Tenant Alert Follow-Up
Summary: A tenant receives a notification that their workload may be causing or experiencing an issue.
Problem: The tenant needs context from the operator without receiving broad cluster privileges.
Action: Mosaic opens the alert context, preserves the relevant operator summary, and lets the tenant continue with workload-facing agents to inspect deployment configuration and plan remediation.

## Operator

### Use Case 6. Node Schedulability Investigation
Summary: An operator wants to know whether a GPU node is currently schedulable and whether workloads can use it safely.
Problem: A node may appear idle now, but earlier drain events or scheduler state may have affected workloads.
Action: Mosaic inspects scheduler and Kubernetes state, summarizes whether the node is allocatable now, and identifies workload-facing constraints that could still block placement.

### Use Case 7. Historical Node Issue Review
Summary: An operator needs to understand why a node previously affected workloads.
Problem: Current Slurm state alone may not explain a prior drain, failed placement, or workload interruption.
Action: Mosaic correlates available scheduler, Kubernetes, and observability evidence, then separates current state from historical symptoms.

### Use Case 8. Cluster Health Triage
Summary: An operator needs a quick view of which machines are healthy, down, installer-failed, or failing health checks.
Problem: Kubernetes, Slurm, and observability tools each expose different fragments of cluster state.
Action: Mosaic queries available cluster state, normalizes the status into a concise summary, and calls out which nodes need attention or exclusion from scheduling.

### Use Case 9. Observability Dashboard Creation
Summary: An operator wants a Grafana view for a specific operational question without manually writing dashboard JSON.
Problem: The operator needs to inspect GPU temperature, utilization, memory temperature, or exporter coverage across nodes.
Action: Mosaic queries Prometheus/Grafana metadata, creates a dashboard focused on the requested metric, and opens it in the side panel for immediate inspection.

### Use Case 10. Operator-To-Tenant Notification
Summary: An operator discovers a workload-level issue while investigating cluster telemetry.
Problem: The operator can see infrastructure metrics but needs the tenant to adjust application-level configuration.
Action: Mosaic summarizes the operator finding, sends a tenant-facing alert, and frames the issue in workload terms such as under-requested GPUs or unbalanced utilization.

## Shared Handoff Workflows

### Use Case 11. End-To-End Performance Incident
Summary: A tenant sees poor model serving performance and the operator needs to verify whether the issue is workload configuration or cluster health.
Problem: The issue spans tenant-owned deployment settings and operator-owned infrastructure telemetry.
Action: Mosaic starts with tenant agents for Slurm and Kubernetes context, escalates to operator observability when needed, then returns a tenant-actionable remediation plan.

### Use Case 12. Safe Shell-Based Cluster Inspection
Summary: A user needs a command executed in a controlled environment without exposing broad host or cluster permissions.
Problem: Direct shell access is too powerful, but some workflows still require command execution such as read-only kubectl checks or filesystem inspection.
Action: Mosaic routes execution through NemoClaw/OpenShell, applies the configured sandbox and network policy, and records the command activity in the audit trail.

### Use Case 13. Audit And Feedback Review
Summary: The team needs to understand which agents and tools were used during an investigation and whether users approved the result.
Problem: Multi-agent operations are hard to review after the fact if tool calls, generated answers, and feedback are scattered.
Action: Mosaic records tool calls, agent activity, thumbs-up and thumbs-down feedback, and dashboard or terminal usage in the Audit and Dashboard tabs so operators can review outcomes and improve workflows.
