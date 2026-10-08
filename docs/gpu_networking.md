# GPU networking diagnosis

The GPU networking skill guides NCCL/RDMA investigation using the workload’s
actual ranks, selected devices, payload, transport and measurements. It checks
every participating host, distinguishes research hypotheses from live findings,
and verifies scoped corrections using fresh measurements and register readback.
ACS experiments require an authorized isolated path, saved controls and timed
rollback. The skill does not change session access permissions.

Research Agent consultation is optional: use it for an explicit research request
or a material documentation gap. The skill and its reference files are bundled
locally; documentation references use workspace-relative paths and need no web
fetch. Research being unavailable does not block checks supported by local
evidence. A correction that depends on unavailable documentation must wait.
Air-gapped use still requires local model and cluster services; enabling Research
also requires its documentation corpus and inference/embedding dependencies to
be available inside the environment.

The chart registers the skill and installs its reference files. To include its
instructions and references in every session, configure:

```yaml
openclaw:
  bootstrapSkills:
    - gpu-networking
```

Preloading is optional and increases prompt size. The chart adjusts the per-file
bootstrap limit for the generated instructions; the model context budget and
other runtime limits still apply. Use skill names provided by this blueprint.

A measured collective improvement does not establish training speedup or full
platform capacity. Placement advice checks pairwise GPU topology and available
resources without moving the workload.

Validation to date includes a two-node, one-GPU-per-node NCCL investigation with
Nemotron Super. Broader hardware and Nemotron Ultra coverage are not established.

## Documentation delivery

The chart contains the skill under `files/openclaw-seed/skills/gpu-networking/`.
Its seed ConfigMap carries the Markdown contents. The BusyBox `init-config`
container copies them into `/home/node/.openclaw/workspace/skills/gpu-networking/`,
including the `references/` directory. No UI image content or startup download
is used for these documents. The bundled platform reference is an operational
summary, not a full vendor-manual archive. Package and mirror the chart and
runtime images ahead of an air-gapped installation.
