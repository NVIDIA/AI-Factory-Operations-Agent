---
name: bcm
description: Inspect read-only Base Command Manager and cluster inventory evidence for node health, categories, and schedulability context.
---

# BCM Cluster Inspection

Use this skill when a user asks about node inventory, node categories, cluster health, or why a node is or was unavailable.

Prefer read-only commands and evidence sources. Do not make provisioning, power, category, or scheduler changes. If BCM CLI tools such as `cmsh` are unavailable in the sandbox, say that the BCM evidence source is unavailable and answer only from Kubernetes, Slurm, or observability evidence that is present.

For node questions, separate current state from historical symptoms. Report node name, current schedulability, category or role if known, observed health state, and the evidence source used.
