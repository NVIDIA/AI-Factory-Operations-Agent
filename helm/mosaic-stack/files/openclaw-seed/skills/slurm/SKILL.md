---
name: slurm
description: Inspect mounted Slurm accounting exports and job logs for failed workload root cause analysis.
---

# Slurm Log RCA

Use this skill when a user asks about a Slurm job failure or queue state.

This workflow is log based. Do not assume any external job-management service exists.

Look for evidence in these mounted paths when present:

- `/slurm/accounting`
- `/slurm/logs`
- `/cm/shared/slurm-logs`
- `/cm/shared/*/slurm-logs`
- `/cm/shared/megatron/logs`
- `/home/node/.openclaw/shared-logs/**`
- `/sandbox/workspace/shared-logs/**`

The chart may seed read-only Slurm/training logs into `/sandbox/workspace/shared-logs` when the original host path is not mounted directly in the sandbox. Search that copied tree before concluding logs are unavailable.

For a failed job, find the job id, job name, state, exit code, runtime, and log path. Read the matching log and report the first concrete application error, not only the Slurm state. If the log is missing, say which expected path was unavailable and what evidence was still present.

Return a compact table with job id, job name, state, exit reason, log path, root cause, confidence, and next action.
