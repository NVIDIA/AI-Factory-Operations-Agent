---
name: bcm
description: Inspect Base Command Manager inventory and health evidence, and make explicitly requested changes when BCM edit mode is enabled.
---

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# BCM Cluster Inspection

Use this skill when a user asks about node inventory, node categories, cluster health, or why a node is or was unavailable.

Use BCM tools, not shell or Slurm tools. For inventory, category, Kubernetes cluster, schedulability, and node state questions, prefer `bcm_execute_cmsh` because it uses the BCM read-only CMSH profile. Use `bcm_get_info`, `bcm_search_tools`, `bcm_execute_tool`, or `bcm_search_notes` for non-CMSH evidence. Do not call `bcm_health` just to start a normal `/cluster-management` request; it may be slow on large clusters. Do not invent CMSH modes or subcommands; `cluster` is not a valid CMSH mode for this workflow, and `device health ...` / `device; use <node>; health` are not valid commands.

When BCM command syntax, modes, concepts, or operational behavior are unclear, search the seeded BCM manuals before guessing. These manuals are normal markdown files, not BCM MCP tools and not the `SKILL.md` file. Never call `bcm_search_docs`; that tool is not available. Use `exec` with read-only shell commands against `/sandbox/workspace/skills/bcm/docs`, for example `find /sandbox/workspace/skills/bcm/docs -type f`, `grep -R <term> /sandbox/workspace/skills/bcm/docs`, and `sed -n`. If running outside OpenShell, the same manuals are also staged at `/home/node/.openclaw/workspace/bcm-docs`. Then return to BCM MCP tools for live cluster evidence. If neither path exists, report that the seeded manuals are not mounted in this deployment.

Some BCM MCP deployments may disable CMSH. If `bcm_execute_cmsh` is absent or returns an error, continue with `bcm_get_info`, `bcm_search_tools`, and `bcm_execute_tool` evidence. Do not claim node inventory or schedulability from CMSH unless `bcm_execute_cmsh` returned that evidence.

Never use BCM MCP `slurm.*` tools for failed-job RCA, Slurm job ids, `sacct`, `scontrol`, Slurm logs, or root-cause questions. Those requests belong to the configured Slurm evidence route, not this BCM skill.

Prefer read-only commands and evidence sources. `bcm_execute_cmsh` always uses the readonly BCM identity and never requests approval. Make a provisioning, power, category, or scheduler change only when the user explicitly requests it and `bcm_execute_cmsh_admin` is available. The admin tool always uses edit capability and may require approval; never use another tool or shell command to bypass a rejection. When HITL is enabled, wait for the approval result and stop after a denial or timeout. If BCM MCP tools are unavailable, say that the BCM evidence source is unavailable and answer only from Kubernetes, Slurm, or observability evidence that is present.

For node questions, separate current state from historical symptoms. Report node name, current schedulability, category or role if known, observed health state, and the exact BCM MCP evidence used.

For health-check summaries, tables, and RCA, use `bcm_node_health_summary` first. If the user asks for a table summarizing node health checks, call only `bcm_node_health_summary`, then answer from those rows. Do not call `bcm_health`, `bcm_search_tools`, `bcm_execute_cmsh`, `device; health`, `monitoring; show health`, `monitoring; help`, or `device; foreach ... health` for this workflow. Treat explicit BCM status text as evidence: examples include `INSTALLER_FAILED (...)`, `CLOSED (DOWN), pingable`, `restart required (...)`, `health check failed`, and `health check unknown`. If the status line already includes a parenthesized reason, use that as the likely root cause instead of probing nonexistent health subcommands. If only `health check failed` is present without a reason, report it as a symptom and say BCM did not expose a more specific cause from `device; status`.

For `is <node> schedulable?`, use BCM evidence first. If CMSH is available, use `device; use <node>; show`; otherwise use available BCM MCP registry tools and notes, and be explicit that schedulability could not be confirmed from CMSH. Do not continue into unrelated hardware or Slurm recovery workflows.

Useful read-only CMSH examples:

Pass CMSH commands as the same semicolon-separated command string used by `cmsh -c`.

- `device; list`
- `device; status`
- `device; use <node>; show`
- `category; list`
- `kubernetes; list`
- `kubernetes; foreach * (show)`

For broad cluster summaries, combine `bcm_get_info` with `bcm_execute_cmsh` command strings such as `kubernetes; list`, `category; list`, and `device; list`. For a short inventory, summarize the first rows returned by `device; list`; do not use shell pipes or `limit` inside CMSH.
