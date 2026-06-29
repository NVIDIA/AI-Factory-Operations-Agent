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

The chart generates and retains the internal OpenClaw gateway token. Installers do not need to provide that credential.

For NMC or Zarf-managed clusters that rewrite image references, keep `--create-namespace` and let the chart label the namespace before regular workload templates run:

```bash
helm upgrade --install mosaic ./helm/mosaic-stack \
  -n mosaic \
  --create-namespace \
  --set-json 'namespace.labels={"zarf.dev/agent":"ignore"}' \
  --reset-values \
  --wait \
  --timeout 12m
```

If the OpenShell sandbox image is private, create the pull Secret in the Mosaic namespace and let the chart attach it to sandbox pods:

```yaml
openshell:
  sandboxImagePullSecret:
    enabled: true
    name: nvcr-image-pull-secret
```

The chart patches the namespace `default` ServiceAccount through a Helm hook so OpenShell-created sandbox pods can pull the configured image.

## 2. LLM Modes

- `llm.mode=vllm`: deploys chart-managed vLLM. Use `helm/mosaic-stack/profiles/vllm-super-1gpu.yaml` for a small single-GPU profile or `helm/mosaic-stack/profiles/vllm-ultra-16gpu.yaml` for a larger distributed profile.
- `llm.mode=external`: does not deploy vLLM. Set `llm.external.baseUrl`, `llm.external.model`, and optionally `llm.external.existingSecret` plus `llm.external.apiKeySecretKey`.

For an external LLM, create the API key as a Kubernetes Secret outside Helm values, then point the chart at it:

```bash
kubectl -n mosaic create secret generic mosaic-external-llm \
  --from-literal=apiKey='<external-llm-api-key>'
```

```yaml
llm:
  mode: external
  external:
    baseUrl: https://inference-api.nvidia.com/v1
    model: aws/anthropic/bedrock-claude-sonnet-4-6
    existingSecret: mosaic-external-llm
    apiKeySecretKey: apiKey
```

Do not put external provider keys directly in committed values files. Keep the Secret creation step in an operator-owned bootstrap path, CI secret store, External Secrets Operator, or another cluster-local secret workflow.

For chart-managed vLLM, install with the selected profile:

```bash
helm upgrade --install mosaic ./helm/mosaic-stack \
  -n mosaic \
  --create-namespace \
  -f helm/mosaic-stack/profiles/vllm-super-1gpu.yaml
```

## 3. Modules

`helm/mosaic-stack/values.yaml` exposes feature modules under `modules.*.enabled`. `modules.bcm.enabled` controls the BCM skill in the OpenClaw seed.

Observability is connected through explicit endpoints:

```yaml
observability:
  prometheusUrl: http://prometheus.mosaic-observability.svc.cluster.local:9090
  grafanaUrl: http://grafana.mosaic-observability.svc.cluster.local:3000
  grafanaUpstreamPrefix: /api/grafana/proxy
```

Those URLs may point at the reference `mosaic-observability` chart or at an existing Prometheus/Grafana deployment.

The embedded Grafana tab is served through Mosaic at `/api/grafana/proxy`. The bundled observability Grafana is configured to serve from that subpath, so the default `observability.grafanaUpstreamPrefix=/api/grafana/proxy` is correct. For an existing Grafana that serves from `/`, set:

```yaml
observability:
  grafanaUpstreamPrefix: /
```

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

For agent clients, run `mosaic-mcp` with `MOSAIC_URL` pointing at the Mosaic service. It exposes `mosaic_chat`, `mosaic_history`, `mosaic_commands`, and the Mosaic/OpenClaw tools enabled by the chart over stdio MCP. See `docs/skills/mosaic-headless/SKILL.md` for Codex setup and port-forward options.

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

Packaged chart releases include a pinned OpenShell Helm dependency and the pinned `kubernetes-sigs/agent-sandbox` prerequisite required by OpenShell's Kubernetes driver.

During `helm/scripts/build_push_images.sh` and `helm/scripts/publish_to_nvcr.sh`, the release process vendors the pinned `agent-sandbox` manifest into the top-level `mosaic-stack` package:

- `CustomResourceDefinition` resources are placed under chart `crds/` so Helm installs them before templates.
- The controller namespace, RBAC, service, and StatefulSet are rendered as normal templates when `agentSandbox.install=true`.

If a cluster already provides a compatible `agent-sandbox` installation, set:

```yaml
agentSandbox:
  install: false
```

For example:

```bash
helm upgrade --install mosaic oci://nvcr.io/0948643769302270/mosaic-stack \
  --version <chart-version> \
  -n mosaic \
  --create-namespace \
  --set agentSandbox.install=false
```

Source installs from `./helm/mosaic-stack` include the tracked `agent-sandbox` CRD and controller templates. Packaged chart releases include the same prerequisite.
