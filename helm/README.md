# Mosaic Helm Deployment

Mosaic is installed with Helm. The public chart surface includes the Mosaic UI, OpenClaw/NemoClaw execution, read-only Kubernetes inspection, observability/Grafana helpers, and vanilla Slurm log RCA.

## 1. Install Or Upgrade

```bash
helm upgrade --install mosaic ./helm/mosaic-stack \
  -n mosaic \
  --create-namespace \
  --reset-values \
  --wait \
  --timeout 12m
```

Set image repositories and tags in values for your registry before installing. The defaults are placeholders for source-based development.

## 2. LLM Modes

- `llm.mode=vllm`: deploys chart-managed vLLM. Use `helm/mosaic-stack/profiles/vllm-super-1gpu.yaml` for a small single-GPU profile or `helm/mosaic-stack/profiles/vllm-ultra-16gpu.yaml` for a larger distributed profile.
- `llm.mode=external`: does not deploy vLLM. Set `llm.external.baseUrl`, `llm.external.model`, and optionally `llm.external.existingSecret` plus `llm.external.apiKeySecretKey`.

## 3. Modules

`helm/mosaic-stack/values.yaml` exposes feature modules under `modules.*.enabled`. `modules.bcm.enabled` controls the BCM skill in the OpenClaw seed.

Observability is connected through explicit endpoints:

```yaml
observability:
  prometheusUrl: http://prometheus.mosaic-observability.svc.cluster.local:9090
  grafanaUrl: http://grafana.mosaic-observability.svc.cluster.local:3000
```

Those URLs may point at the reference `mosaic-observability` chart or at an existing Prometheus/Grafana deployment.

## 4. Open The UI

```bash
kubectl -n mosaic port-forward svc/mosaic-ui 3000:3000
```

Open `http://localhost:3000`.

## 5. Headless Mode

The Mosaic UI service also exposes a headless API:

```bash
curl -sS http://localhost:3000/api/headless/chat \
  -H 'content-type: application/json' \
  -d '{"prompt":"summarize whether the cluster is healthy","sessionKey":"headless"}'
```

Inside the `mosaic-ui` container, the same path is available as a CLI:

```bash
mosaic "summarize whether the cluster is healthy"
```

For agent clients, run `mosaic-mcp` with `MOSAIC_URL` pointing at the Mosaic service. It exposes `mosaic_chat`, `mosaic_history`, and `mosaic_commands` over stdio MCP.

## Vanilla Slurm RCA

The public Slurm workflow is evidence based. By default, the chart deploys a read-only Slurm evidence collector. The collector mounts the host filesystem read-only inside the collector pod, exposes bounded HTTP tools to OpenClaw, and keeps broad host filesystem access out of the LLM sandbox.

Default collector roots:

- `/var/log/slurm`
- `/var/log`
- `/cm/shared`
- `/slurm/logs`
- `/slurm/accounting`
- `/etc/slurm`
- `/cm/shared/apps/slurm/etc`
- `/run/log/journal`
- `/var/log/journal`

The Slurm skill first calls `slurm_job_evidence`, then falls back to read-only `sacct`/`scontrol` and any mounted evidence available in the sandbox. Missing paths are expected on many clusters; the skill continues with whatever evidence is present. Adjust `slurmEvidenceCollector.roots` only when a site stores Slurm evidence outside the default candidates.

## OpenShell Dependency

Packaged chart releases include a pinned OpenShell Helm dependency. Source installs should either vendor that dependency through the release process or install a compatible OpenShell chart before deploying Mosaic.
