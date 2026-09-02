---
name: ai-factory-operations-agent-headless
description: Use AI Factory Operations Agent without opening the browser UI. Invoke it through the headless HTTP API, packaged CLI, or stdio MCP server, and deploy it first when no service is available.
---

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# AI Factory Operations Agent Headless Service

Use this skill when a coding agent needs AI Factory Operations Agent to answer an operational question or use its tools from another agent runtime.

## Check For An Existing Service

If `MOSAIC_URL` is already set, use it. Otherwise try the local default:

```bash
curl -fsS http://127.0.0.1:3000/api/openclaw/commands >/dev/null
```

For a Kubernetes deployment, port-forward the UI service and set `MOSAIC_URL`:

```bash
kubectl -n mosaic port-forward svc/mosaic-ui 3000:3000
export MOSAIC_URL=http://127.0.0.1:3000
```

Use the target namespace instead of `mosaic` if the operator installed the service elsewhere.

## Invoke By CLI

Inside the `mosaic-ui` image, or anywhere the packaged CLI has been installed:

```bash
mosaic --session headless "summarize whether the cluster is healthy"
```

Useful options:

- `--url URL`: service URL. Defaults to `MOSAIC_URL` or `http://127.0.0.1:3000`.
- `--session KEY`: conversation key. Defaults to `MOSAIC_SESSION` or `headless`.
- `--timeout-ms MS`: maximum wait for a final answer. Defaults to `120000`.
- `--json`: return the full JSON response.
- `--concise`: request compact output.

## Invoke By HTTP

Use the headless API when the CLI is not installed:

```bash
curl -sS "$MOSAIC_URL/api/headless/chat" \
  -H 'content-type: application/json' \
  -d '{"sessionKey":"headless","prompt":"summarize whether the cluster is healthy"}'
```

The response includes `success`, `message`, `sessionKey`, `runId`, `elapsedMs`, and serialized `messages`.

## Invoke As MCP

The HTTP service is the backend for a local stdio MCP bridge; it does not expose an HTTP `/mcp` endpoint. Install the bridge on the client machine (Node.js 18 or newer is required):

```bash
git clone https://github.com/NVIDIA/AI-Factory-Operations-Agent.git
cd AI-Factory-Operations-Agent
install -d ~/.local/bin
install -m 0755 utils/mosaic-mcp.mjs ~/.local/bin/mosaic-mcp
```

Tools exposed:

- `ai_factory_operations_agent_chat`: investigate or operate using configured agents.
- `ai_factory_operations_agent_history`: read conversation history.
- `ai_factory_operations_agent_commands`: list slash commands and agent entrypoints.
- Every OpenClaw tool available to the deployed agent, including BCM, Kubernetes, observability, Slurm, and shell tools when enabled by the chart.

Add the service to Claude Code with a local bridge that points at the UI service:

```bash
claude mcp add ai_factory_operations_agent \
  -e MOSAIC_URL=http://127.0.0.1:3000 \
  -- ~/.local/bin/mosaic-mcp
```

Add the same bridge to Codex with:

```toml
[mcp_servers.ai_factory_operations_agent]
command = "/home/USER/.local/bin/mosaic-mcp"
env = { MOSAIC_URL = "http://127.0.0.1:3000" }
```

Or install it with the Codex CLI:

```bash
codex mcp add ai_factory_operations_agent --env MOSAIC_URL=http://127.0.0.1:3000 -- \
  ~/.local/bin/mosaic-mcp
```

After adding or changing a Codex MCP server, restart Codex and run `/mcp`. A stdio server may show `Auth: Unsupported`; that is expected. The success condition is that the `ai_factory_operations_agent` server is enabled and tools such as `ai_factory_operations_agent_chat`, `bcm_execute_cmsh`, and `bcm_node_health_summary` are listed.

Quick direct-tool check after restart:

```text
call bcm_execute_cmsh with commands: kubernetes; list
```

Expected output is a read-only BCM CMSH result listing Kubernetes clusters for the target environment.

Prefer `ai_factory_operations_agent_chat` for open-ended operational questions. Use direct tools such as `bcm_execute_cmsh` when you already know the exact tool you want to call.

## Example Operational Queries

Use the deployed agents for cluster investigations where they have relevant evidence:

- `/cluster-management use BCM health checks to find hardware with health-check problems, then identify the clearest root cause and evidence.`
- `/k8s summarize whether the deployment is healthy and call out unhealthy pods, restarts, and recent events.`
- `/observability check GPU temperatures for the cluster over the last hour and report whether any GPU is hot.`
- `/observability give me a Grafana dashboard for GPU temperatures.`
- `/slurm job 339 failed. Use the Slurm logs and summarize the root cause.`

For BCM health RCA, prefer broad read-only status first. Ask for explicit status evidence such as `INSTALLER_FAILED`, `CLOSED (DOWN)`, `restart required`, or parenthesized BCM failure reasons.

## Deploy If It Is Not Running

Install from the packaged Helm chart:

```bash
# Remove --devel for the latest stable release, or replace it with --version 0.0.1 to pin that release.
helm upgrade --install mosaic oci://nvcr.io/0948643769302270/mosaic-stack \
  --devel \
  -n mosaic \
  --create-namespace \
  --wait \
  --timeout 12m
```

For source-based development, deploy the tracked chart from the repository:

```bash
helm upgrade --install mosaic ./helm/mosaic-stack \
  -n mosaic \
  --create-namespace \
  --reset-values \
  --wait \
  --timeout 12m
```

Before deploying, set image repositories/tags and LLM mode for the target cluster. For an external LLM, use `llm.mode=external` with `llm.external.baseUrl` and `llm.external.model`. For chart-managed vLLM, use one of the profiles under `helm/mosaic-stack/profiles/` and ensure the cluster has the requested GPUs.

After install, verify readiness:

```bash
kubectl -n mosaic rollout status deploy/mosaic-ui --timeout=5m
kubectl -n mosaic get pods
```

Then port-forward `svc/mosaic-ui`, set `MOSAIC_URL`, and call the service headlessly.

## Behavior Notes

- Headless mode uses the same service and OpenClaw-backed agents as the browser UI.
- It waits for a completed assistant turn instead of returning immediately after sending.
- It does not grant new permissions. Available tools and Kubernetes/cluster access are exactly what the deployed chart configured.
- Do not bypass the service by calling internal OpenClaw gateway APIs directly unless debugging the service itself.
