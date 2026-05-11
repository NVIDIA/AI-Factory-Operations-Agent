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

## Cluster Inventory Checks

For cluster inventory, GPU inventory, or drift checks:

- Start with `bcm_health` and `bcm_get_info`.
- Try CMSH once if device inventory is needed. If CMSH returns `cmsh: command not found`, do not retry CMSH with alternate formatting or guessed paths.
- Try parallel host contexts once if useful. If output says `pdsh not found`, do not retry `pdsh` genders or hostlist variants.
- When CMSH or `pdsh` is unavailable, fall back to working read-only evidence: `bcm_execute_tool` for direct system tools, BCM exporter metrics, DCGM GPU telemetry, and observability queries if those tools are available.
- For a GPU drift answer, identify the nodes actually observed, their GPU counts/models/utilization if available, any missing exporters or unavailable inventory paths, and whether the observed GPU nodes disagree.

## Hardware Baseline Checks

For hardware baseline, firmware baseline, pre-maintenance baseline, or platform inventory requests, keep the user prompt simple and do the detailed read-only collection here:

- Use `bcm_execute_tool` with `system.file_read` for DMI and firmware paths such as `/sys/class/dmi/id/product_name`, `/sys/class/dmi/id/product_version`, `/sys/class/dmi/id/bios_vendor`, `/sys/class/dmi/id/bios_version`, `/sys/class/dmi/id/bios_date`, `/sys/class/dmi/id/board_version`, and `/proc/driver/nvidia/version`.
- Use `bcm_execute_tool` with `system.file_read` for InfiniBand facts such as `/sys/class/infiniband/mlx5_0/fw_ver` and `/sys/class/infiniband/mlx5_0/ports/1/state` when those paths exist.
- Use `bcm_execute_tool` with `system.file_read` for NVMe model and firmware paths such as `/sys/block/nvme0n1/device/model`, `/sys/block/nvme0n1/device/firmware_rev`, `/sys/block/nvme2n1/device/model`, and `/sys/block/nvme2n1/device/firmware_rev` when those block devices exist.
- Use `bcm_execute_tool` with `system.lspci` to summarize PCIe topology for NVIDIA GPUs, Mellanox/ConnectX InfiniBand, BlueField if present, and NVMe controllers.
- If tools such as `dmidecode`, `nvidia-smi`, `nvme`, or `ibv_devinfo` are missing inside the BCM runtime, state that once and use sysfs, procfs, and `lspci` instead.
- Finish with the observed platform fingerprint, BIOS/driver/firmware versions, fabric/storage topology, mismatches worth checking before maintenance, and explicit note that the collection was read-only.

## Response Rules

Preserve important identifiers from BCM output: node names, categories, software images, Kubernetes cluster names, device names, users, ports, package versions, and command/tool IDs.

BCM MCP tools are intended to be read-only. Do not invent write actions or claim remediation was performed unless a tool output explicitly confirms it.
