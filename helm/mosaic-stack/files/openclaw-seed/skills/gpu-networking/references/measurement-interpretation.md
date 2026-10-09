## Quantitative grounding

### Interpret the measurement

For NCCL tests, algorithm bandwidth is payload bytes divided by operation seconds. All-reduce bus bandwidth multiplies it by `2*(ranks-1)/ranks`; other collectives have different factors. Bus bandwidth characterizes the communication bottleneck, not the sum of every link installed in the machine. At large payloads, operation time includes data transfer and must not be compared with small-message latency. Distinguish decimal GB/s from GiB/s and bits/s. See `skills/gpu-networking/references/platform-contracts.md` (collective measurement).

Choose a reference by the evidence available:

| Available evidence | What it establishes |
|---|---|
| GPU model or installed GPU count | Device identity, no collective performance target |
| Selected NIC line rate | Wire ceiling for that link, no expected achieved rate |
| NVLink topology inside one host | Local GPU connectivity, no rate for a separate inter-host network |
| Healthy benchmark with matching operation, placement, payload and timing | A comparable performance reference |
| Same benchmark before and after a change | Measured improvement, not peak utilization or training speedup |

Convert a network rate in Gbit/s to a decimal GB/s ceiling by dividing by eight. Protocol, software and topology overhead reduce achieved throughput. Do not add unused NICs or bidirectional rates to a one-direction path. A directly observed configuration problem can be diagnosed without inventing a healthy performance target. In that case, give the configuration finding and current measurement, then verify recovery experimentally.

### Interpret configuration using its documented scope

These controls have separate scopes; interpret them using the bundled transport reference at `skills/gpu-networking/references/platform-contracts.md` for the installed version:

| Control | Documented scope |
|---|---|
| `NCCL_NET` | Selects the collective network implementation |
| `NCCL_IB_DISABLE` | Value `1` excludes the IB/RoCE transport; another available transport may be selected |
| `NCCL_IB_HCA` | Filters RDMA interfaces; it cannot enable a disabled transport |
| `NCCL_SOCKET_IFNAME` | Selects IP interfaces; remains relevant for socket transport and bootstrap, and does not by itself disable RDMA |
| `NCCL_NET_GDR_LEVEL` | Controls eligible GPU-to-NIC topology distance for GPUDirect RDMA |

Preserve exact-match prefixes in interface values. Distinguish a setting that disables a transport from a setting that selects an interface within that transport.

A mounted RDMA device establishes visibility, not a working RDMA path. GPU-direct communication also depends on drivers, memory registration, topology, link state and permissions. Verify the initialized path and an actual collective before claiming it works. See `skills/gpu-networking/references/platform-contracts.md` (NCCL transport and GPU-direct checks).



For each quantity in the answer, identify its observed field or its measured inputs and formula. For each documented limit, identify the exact source and matching scope. Omit quantities without evidence. Preserve units and measurement meaning: a benchmark-derived bandwidth is not a measured physical-link utilization, and software version numbers must come from their actual version fields.

An estimate requires a comparable reference with matching topology and benchmark method. If that reference is unavailable, state that the achievable rate is unestablished. Do not substitute GPU-family knowledge or unused installed links.

In concise mode, give one compact answer for the selected branch. Avoid repeating the same finding in configuration lists, tables and a closing summary.

### Evaluate placement separately from workload size

Rank count, GPU count and placement are separate properties. A placement alternative relocates the existing ranks while preserving their number, collective and payload; it does not inherently add ranks or GPUs. Check actual GPU connectivity, allocations, active processes, memory needs and scheduling constraints before identifying a feasible alternative. Installed inventory alone does not establish availability. A read-only placement question authorizes inspection and a recommendation, not a workload move. Explain how the alternative changes the communication path, and leave its achieved performance unclaimed until measured.
