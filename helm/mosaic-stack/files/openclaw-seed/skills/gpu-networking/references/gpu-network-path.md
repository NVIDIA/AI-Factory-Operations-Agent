# GPU-to-network diagnostic reference

## Establish the selected path

Map the workload's CUDA device and selected RDMA interface to their actual PCI addresses. Inspect their sysfs ancestry and negotiated link state; do not infer locality from device numbering. Preserve the current participating ranks and interface selection while isolating a fault.

Establish an explicit mapping before selecting bridges:

- Obtain the participating GPU UUID and PCI bus ID from the workload's device visibility and `nvidia-smi --query-gpu=uuid,pci.bus_id --format=csv,noheader`. Container CUDA ordinals can differ from host ordinals.
- Resolve each selected HCA's `/sys/class/infiniband/<hca>/device` symlink. `ibdev2netdev -v` also reports the PCI/HCA/network-device associations. Select the observed HCA, not the first network controller in an inventory.
- Resolve `/sys/bus/pci/devices/<domain:bus:device.function>` for both endpoints. The physical ancestor directories identify their bridge paths; inspect those bridges with `lspci -vvv -s <bridge>`. A bridge on another NIC's path cannot explain the selected transfer.

Resolve the canonical paths directly; optional inventory utilities are not required. Use existing PCI directory names from sysfs or `lspci -D`: these use a four-digit hexadecimal domain and lowercase bus/device letters. NVIDIA-SMI may print a longer domain and uppercase letters; numerical identity is unchanged, but filesystem paths are case-sensitive. After setting `gpu_bdf` and `hca` from the workload's observed identities, resolve existing paths:

```sh
readlink -e "/sys/bus/pci/devices/$gpu_bdf"
readlink -e "/sys/class/infiniband/$hca/device"
```

Each returned PCI ancestor must appear in the inspection inventory for that host. Preserve the ordered paths in working evidence before reducing them to a concise answer. Do not substitute adjacent bus numbers or a guessed topology for these observations.

See the PCI device mapping section in `skills/gpu-networking/references/platform-contracts.md` for the bundled sysfs and interface mapping definitions.

Run these reads in the workload's execution environment. For Kubernetes, request noninteractive `exec` through `run_kubectl_admin` with native approval in Edit mode, or within the authorized scope in Auto mode. The name denotes the execution capability, not whether the diagnostic command writes data. Ordinary sandbox `exec` runs in the agent sandbox and does not provide node access or node credentials.

## Inventory every selected path before interpreting it

Use this read-only Bash inventory with the discovered endpoint sysfs paths as arguments. It walks each endpoint's complete ancestry, including separate branches, and emits each PCI bridge once. It reads the numeric ACS control and decodes the two redirection flags; it never writes a register. Run it in each participating workload container through `run_kubectl_admin` with `exec -i ... -- bash -s -- <endpoint-path> ...` and the script as stdin. Missing ACS capability on one bridge says nothing about other bridges.

```bash
set -eu
declare -A seen
for endpoint in "$@"; do
  path=$(readlink -e "$endpoint") || exit 1
  printf 'endpoint %s -> %s\n' "$endpoint" "$path"
  while [ -n "$path" ] && [ "$path" != / ]; do
    if [ -f "$path/class" ]; then
      read -r class < "$path/class"
      case "$class" in
        0x0604*)
          bdf=${path##*/}
          if [ -z "${seen[$bdf]:-}" ]; then
            seen[$bdf]=1
            printf 'bridge %s ' "$bdf"
            if control=$(setpci -s "$bdf" ECAP_ACS+6.w 2>/dev/null); then
              value=$((16#$control))
              printf 'ACS_control=%s request_redirect=%d completion_redirect=%d\n' "$control" "$(((value >> 2) & 1))" "$(((value >> 3) & 1))"
            else
              printf 'ACS_control_unavailable\n'
            fi
          fi
          ;;
      esac
    fi
    path=${path%/*}
  done
done
```

Use the full emitted bridge inventory for subsequent link/isolation checks and documentation research. A common-ancestor-only inspection is incomplete: traffic also traverses the independent branches. A successful correction requires fresh measurements from all participating ranks after all intended changes.

## NVIDIA troubleshooting checks

The GPU-direct checks in `skills/gpu-networking/references/platform-contracts.md` identify several independent requirements:

- GPU-to-NIC direct access needs compatible drivers and either the peer-memory module or supported DMA-BUF operation. A missing peer-memory module alone is not a failure when DMA-BUF is active.
- Containers must expose the real PCI topology through sysfs. An incorrect topology view can impair path selection.
- Inspect active IOMMU mode and PCIe ACS controls. Redirection through the CPU root complex can impair direct transfers even when the collective initializes successfully.
- Read each observed ancestor bridge with `lspci -s <bridge> -vvv`. Keep detailed output scoped to the selected path; a full-host verbose dump can exceed tool output and context limits. ACS capability support is different from active control settings.
- Virtual machines have isolation requirements that differ from bare metal; do not disable ACS in a VM deployment.

These are diagnostic candidates, not a diagnosis of the current system. Correlate each with the selected device path and observations. Query the research tool with the concrete mechanism being investigated when additional platform guidance is needed.

## Interpret and scope an ACS experiment

The bundled ACS register definitions in `skills/gpu-networking/references/platform-contracts.md` place ACS control at capability offset 0x06. Request redirection uses mask 0x0004 and completion redirection 0x0008. Source validation is a separate bit; its state alone does not establish that both redirection controls are enabled.

The register operations documented in `skills/gpu-networking/references/platform-contracts.md` support word reads and masked read-modify-write values in `data:mask` form. A mask changes only its selected bits. Derive the write from the requested control change and the saved register value; do not zero unrelated controls.

Use named capability-relative register addressing instead of calculating absolute offsets from a dump. The extended capability header, advertised capability bits, and writable control word are different registers. Read-only support bits cannot disable an active control, and a wider write can touch adjacent registers. Use the documented register width and verify both the raw readback and decoded control state.

For ACS, the named control word is `ECAP_ACS+6.w`. After discovering a bridge on the active path, confirming the authorization and isolation conditions above, and saving its original control word, the request/completion-only operation is:

```sh
setpci -s "$bridge_bdf" ECAP_ACS+6.w=0000:000c
setpci -s "$bridge_bdf" ECAP_ACS+6.w
lspci -s "$bridge_bdf" -vvv
```

The expected readback equals the saved word with only mask `000c` cleared. Stop if another bit changes or the decoded request/completion controls remain active. Repeat only for independently verified bridges in the selected paths; neither a successful exit code nor a register value alone proves a performance improvement.

For an authorized bare-metal comparison, build a per-host list of every ancestor bridge on each participating GPU/NIC path from the resolved sysfs paths. A topology summary may omit intermediate bridges; do not infer the complete path from indentation or endpoint bus numbers. Inspect other devices and workloads under those bridges before writing. Save original words and arrange timed restoration before the experiment. Use native approval for exact selected devices and masked writes in Edit mode; in Auto mode retain the same device, workload and rollback constraints without requesting repeated approval. Avoid broad all-device loops. Repeat the unchanged benchmark, restore exact originals and verify both register state and control measurements. A kernel/firmware persistence change is a separate operation.
