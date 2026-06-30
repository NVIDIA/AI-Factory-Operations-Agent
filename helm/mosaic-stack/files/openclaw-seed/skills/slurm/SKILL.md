---
name: slurm
description: Inspect mounted Slurm accounting exports and job logs for failed workload root cause analysis.
---

# Slurm Log RCA

Use this skill when a user asks about a Slurm job failure or queue state.

This workflow is evidence based. Do not assume any external job-management service exists.

First use `slurm_job_evidence` when available. Its `backend` field identifies whether the evidence came from the vanilla read-only filesystem collector or BCM WLM. BCM WLM evidence includes job metadata, stdout, and stderr; vanilla evidence includes bounded matches from the configured filesystem roots.

If the tool is unavailable or incomplete, try read-only Slurm commands if they are available in the sandbox:

- `sacct -j <job-id> --format=JobID,JobName,State,ExitCode,Elapsed,Start,End,NodeList%40,Comment%80 -P`
- `scontrol show job <job-id>`

If a command is missing, not configured, or cannot reach the Slurm controller, continue with any other evidence source that is available. The collector searches allowlisted host roots such as `/var/log`, `/cm/shared`, `/slurm`, `/etc/slurm`, `/run/log/journal`, and `/var/log/journal`.

Treat each evidence source as optional. If one path or command is unavailable, keep investigating with the remaining sources before concluding there is not enough evidence.

For a failed job, find the job id, job name, state, exit code, runtime, node list, and log path. Read the matching log and report the first concrete application error, not only the Slurm state. If the main job log is missing, say which expected paths were unavailable and what evidence was still present.

Return a compact table with job id, job name, state, exit reason, log path, root cause, confidence, and next action.
