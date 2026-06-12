---
name: slurm
description: Inspect mounted Slurm accounting exports and job logs for failed workload root cause analysis.
---

# Slurm Log RCA

Use this skill when a user asks about a Slurm job failure or queue state.

This workflow is evidence based. Do not assume any external job-management service exists.

First try read-only Slurm commands if they are available in the sandbox:

- `sacct -j <job-id> --format=JobID,JobName,State,ExitCode,Elapsed,Start,End,NodeList%40,Comment%80 -P`
- `scontrol show job <job-id>`

If a command is missing, not configured, or cannot reach the Slurm controller, continue with mounted evidence. Search these default mounted paths when present:

- `/sandbox/workspace/slurm-evidence/var-log-slurm`
- `/sandbox/workspace/slurm-evidence/var-log-slurm-llnl`
- `/sandbox/workspace/slurm-evidence/cm-shared-slurm-logs`
- `/sandbox/workspace/slurm-evidence/cm-shared-megatron-logs`
- `/sandbox/workspace/slurm-evidence/slurm-logs`
- `/sandbox/workspace/slurm-evidence/slurm-accounting`

Also check equivalent direct mount paths if present: `/var/log/slurm`, `/var/log/slurm-llnl`, `/cm/shared/slurm-logs`, `/cm/shared/megatron/logs`, `/slurm/logs`, and `/slurm/accounting`.

Treat each evidence source as optional. If one path or command is unavailable, keep investigating with the remaining sources before concluding there is not enough evidence.

For a failed job, find the job id, job name, state, exit code, runtime, node list, and log path. Read the matching log and report the first concrete application error, not only the Slurm state. If the main job log is missing, say which expected paths were unavailable and what evidence was still present.

Return a compact table with job id, job name, state, exit reason, log path, root cause, confidence, and next action.
