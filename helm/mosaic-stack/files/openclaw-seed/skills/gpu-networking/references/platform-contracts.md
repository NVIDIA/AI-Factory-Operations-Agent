# Offline GPU networking contracts

This bundled operational reference contains the definitions used by the GPU
networking skill. It summarizes NVIDIA-SMI topology, NCCL benchmark and transport
semantics, Linux PCI/sysfs layout, and pciutils register operations. It is not a
complete copy of the upstream manuals. For behavior that varies with the installed
software or platform, inspect local command help, installed documentation and
runtime evidence; do not invent a version-specific guarantee.

## GPU topology

In the GPU-to-GPU matrix from `nvidia-smi topo -m`, each entry describes the
connection between its row GPU and column GPU. `NV#` means connectivity across a
bonded set of that many NVLinks. The number is not a domain identifier. CPU and
NUMA affinity describe host locality and do not partition the NVLink fabric.
Use the legend printed by the installed command for other symbols.

## PCI device mapping

Linux sysfs represents device ancestry through canonical directories. Resolve
`/sys/bus/pci/devices/<domain:bus:device.function>` and
`/sys/class/infiniband/<hca>/device` with `readlink -e`. PCI ancestors of the GPU
and HCA identify the paths to inspect. `ibdev2netdev -v`, when installed, provides
PCI/HCA/network-interface associations. GPU container ordinals are not stable
host identities; use UUID and PCI address to establish the mapping.

## ACS register access

The ACS control word is at offset `0x06` within the ACS extended capability.
Request redirection is mask `0x0004`; completion redirection is `0x0008`.
Capability support and active control settings are different. Source validation
is a separate control and cannot establish either redirection state.

In pciutils, `setpci -s <bdf> ECAP_ACS+6.w` reads this control word. The `.w`
suffix selects a 16-bit access. A write in `data:mask` form changes only masked
bits. The required safety checks and scoped correction procedure are in
`skills/gpu-networking/references/gpu-network-path.md`; this register definition
alone does not authorize a write. Missing ACS capability is not a zero control.

## Collective measurement

Algorithm bandwidth is payload bytes divided by collective duration. For
all-reduce, NCCL tests normalize bus bandwidth by multiplying algorithm bandwidth
by `2 * (ranks - 1) / ranks`. Other collectives use different factors. This is a
benchmark-derived normalization, not a physical NIC counter or the sum of unused
links. A large-message operation duration is not small-message latency.

A network line rate in decimal Gbit/s divided by eight gives decimal GB/s.
Protocol and software overhead reduce achievable payload throughput. Compare
only measurements with matching collective, message size, ranks, devices,
topology and timing method.

## NCCL transport and GPU-direct checks

`NCCL_NET` selects a network implementation. `NCCL_IB_DISABLE=1` excludes the
IB/RoCE transport; `NCCL_IB_HCA` filters its interfaces. `NCCL_SOCKET_IFNAME`
selects IP interfaces and may affect bootstrap even when data uses RDMA.
`NCCL_NET_GDR_LEVEL` controls eligible GPU-to-NIC topology distance for GPU-direct
RDMA. Preserve exact-match interface prefixes and confirm the chosen transport
in initialization logs. Defaults and supported values can vary by NCCL version.

GPU-direct access requires compatible drivers, device visibility, correct
PCI topology and working memory registration. Either peer-memory support or
supported DMA-BUF operation may provide registration. A missing peer-memory
module alone is not a fault if DMA-BUF is active. Check negotiated links and
errors on the selected path. A mounted RDMA device or successful bootstrap does
not establish the data transport or its performance. Virtual-machine isolation
requirements must be preserved; do not disable ACS in a VM deployment.
