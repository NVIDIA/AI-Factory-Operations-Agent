---
name: gpu-networking
description: Measure and diagnose distributed GPU networking performance: NCCL collectives, RDMA transport, PCIe topology, link health, IOMMU and ACS. Use for current bandwidth/latency questions and follow-up bottleneck investigations or corrections.
---

# GPU networking and performance

All documentation paths below are relative to the agent workspace. These files
are installed from the Helm chart. Read them locally; no web lookup is required.

## Measurement

Resolve the workload's pods and nodes with `run_kubectl`. Establish the collective, payload, ranks, participating devices, units and sampling window from current metrics, bounded logs and benchmark source when needed. Report observations without rating performance against an assumed target. Use `skills/gpu-networking/references/measurement-interpretation.md` for quantitative comparisons.

## Diagnosis

Complete this sequence before answering a cause question. Keep a record for **every participating host**, not just one representative machine.

1. Inspect workload configuration and initialization logs to identify the selected GPU and HCA, actual data transport and GPU-direct registration. Socket bootstrap is not the data transport. Read negotiated link speed and error counters. Do not infer them from hardware family names.
2. Use `run_kubectl_admin` with `exec` through the existing workload pods when their security context and mounted devices permit diagnostics. Pass `-i` before `--` when supplying stdin. Inspect actual visibility; ordinary sandbox `exec` is not the workload node. BCM supplies inventory and managed health, not an arbitrary shell through invented context parameters.
3. On each host, map the participating GPU UUID and HCA to PCI addresses and resolve both canonical sysfs paths with `readlink -e`. Normalize NVIDIA-SMI's PCI address to Linux's lowercase, four-digit domain. Inventory the **union of both complete ancestor paths**, including separate branches, using `skills/gpu-networking/references/gpu-network-path.md`. Read negotiated links and active controls on those bridges. Missing output is missing evidence; adjacent bus numbers and endpoint dumps do not fill the gap.
4. Separate capabilities from enabled controls. For ACS, inspect `ACSCtl` request/completion redirection, not just `ACSCap`. Check isolation requirements and other workloads/devices sharing the path. An unrelated device's health warning does not explain this workload.
5. Use the bundled references and live evidence to distinguish candidate causes. Consult the Research Agent only when the user requests research or a material documentation gap remains, such as an undocumented control or version-specific behavior. Include measured observations and the unresolved question; treat its suggestions as hypotheses and verify them on every participating host. Research availability is not a prerequisite when local evidence and references suffice. If needed documentation is unavailable, continue independent diagnostics and withhold any correction that depends on it.

**Diagnosis completion:** the proposed cause must match direct observations on the selected path. Do not substitute a research report or a list of health warnings for that evidence. State uncertainty when evidence genuinely cannot be obtained; do not stop while the applicable checks remain available.

## Correction and verification

Use the user's access mode and authorized scope: View cannot perform administrative pod execution, Edit requires native approval, and Auto executes authorized changes. Correct invalid arguments through the same tool; never bypass an access denial.

Before writing, inspect all participating hosts independently, save originals, establish timed rollback, and identify the smallest change supported by the diagnosis. Do not assume that hosts share addresses or settings. Never weaken isolation for a VM or unrelated tenant.

For runtime ACS corrections, clear only request/completion redirection bits (`0x0004` and `0x0008`) with masked read-modify-write. Preserve other bits. Keep the same running benchmark, placement, devices, payload and timing; no restart is needed to observe this runtime change. Do not reboot, alter firmware or boot configuration, or change unrelated devices.

**Correction completion:** check the saved per-host inventory against actual writes and readbacks. Every participating host and every relevant bridge must be accounted for. Then collect fresh measurements on every rank after the last change. Partial improvement requires checking path coverage and competing causes; it does not establish that the correction is complete. A scrape or log sample from before the last change cannot verify it.

For a controlled causality test, restore exact originals and measure the control condition; report any authorized reapplication and final state. Honor an explicit request to leave a successful correction active. Use bounded retained logs rather than process descriptors or pipes.

## Present results and placement options

Explain the verified cause and measured before/after result briefly. Distinguish a collective benchmark gain from training speedup or rated platform capacity. Match dashboard units, labels and time range to the workload, then call `dashboard_open` to show it.

For a placement question, keep the job's rank count fixed and inspect both topology and resource availability, including allocations and scheduling constraints. Evaluate the proposed new path; do not confuse moving the existing ranks with adding ranks. Leave placement unchanged unless the user requests a move.

Read topology as pairwise connectivity: the entry at a GPU row and GPU column describes that pair. In the bundled topology reference at `skills/gpu-networking/references/platform-contracts.md`, `NV#` denotes a connection across a bonded set of NVLinks; the number is not a domain identifier. CPU/NUMA affinity and PCIe locality describe different relationships and do not partition the NVLink fabric. Derive connectivity claims from the GPU-to-GPU entries, not assumed groups or physical layout.
