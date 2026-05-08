---
name: bcm
description: "BCM stands for Base Command Manager. Inspect BCM cluster configuration and run read-only diagnostics through bcm-mcp-tools. Use for BCM, CMSH, node inventory, Kubernetes-on-BCM, system, GPU, network, storage, and cluster-note questions that require live BCM command output."
metadata:
  {
    "openclaw":
      {
        "emoji": "server",
        "requires":
          {
            "tools":
              [
                "bcm_health",
                "bcm_get_info",
                "bcm_search_tools",
                "bcm_execute_tool",
                "bcm_execute_cmsh",
                "bcm_list_notes",
                "bcm_search_notes",
                "bcm_add_note",
                "bcm_remove_note",
                "bcm_search_docs"
              ]
          }
      }
  }
---

# bcm - Base Command Manager MCP Diagnostics

BCM stands for Base Command Manager. Use `bcm_*` tools when the user asks for live BCM cluster state, node inventory, CMSH data, system diagnostics, Kubernetes diagnostics through BCM, GPU checks through BCM nodes, or cluster-specific notes.

## First Step

Call `bcm_health` if there is any doubt that the BCM MCP endpoint is reachable. A healthy response should show the endpoint as reachable and list the MCP tools exposed by bcm-mcp-tools.

## Tool Routing

- Use `bcm_get_info` for a quick cluster identity and environment check.
- Use `bcm_search_tools` before `bcm_execute_tool` when you do not know the exact bcm-mcp-tools `tool_id`.
- Use `bcm_execute_tool` for read-only registry tools such as `bcm.get_info`, `system.uname`, `gpu.nvidia_smi`, or `kubernetes.kubectl_get`.
- Use `bcm_execute_cmsh` for BCM configuration via CMSH. Send newline-separated commands such as `device\nlist` or `device\nuse node001\nshow`.
- Use `bcm_search_notes` before deeper investigation when the user asks about a recurring issue, known local quirks, or prior incidents.
- Use `bcm_add_note` only to save meaningful findings from the current investigation. Use `bcm_remove_note` only when the user explicitly asks to delete or replace a note.
- Use `bcm_search_docs` when the configured BCM MCP server has local documentation search enabled. If it fails because docs search is unavailable, report that plainly and continue with live tools.

## Response Rules

Preserve important identifiers from BCM output: node names, categories, software images, Kubernetes cluster names, device names, users, ports, package versions, and command/tool IDs.

BCM MCP tools are intended to be read-only. Do not invent write actions or claim remediation was performed unless a tool output explicitly confirms it.
