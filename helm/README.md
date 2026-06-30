# Mosaic Helm Deployment

Mosaic is installed with Helm. The public chart surface includes the Mosaic UI, OpenClaw/NemoClaw execution, read-only Kubernetes inspection, observability/Grafana helpers, and vanilla Slurm log RCA.

## 1. Install Or Upgrade

```bash
printf '%s' "$NGC_API_KEY" | helm registry login nvcr.io -u '$oauthtoken' --password-stdin
helm dependency build ./helm/mosaic-stack

helm upgrade --install mosaic ./helm/mosaic-stack \
  -n mosaic \
  --create-namespace \
  --set global.registryCredentials.create=true \
  --set-string global.registryCredentials.password="$NGC_API_KEY" \
  --reset-values \
  --wait \
  --timeout 12m
```

Set `NGC_API_KEY` before running these commands. The registry login authenticates the local Helm client for the private OpenShell chart dependency. The upgrade creates `nvcr-image-pull-secret` in the release namespace and attaches it to Mosaic, OpenShell, and dynamically created sandbox pods.

The chart generates and retains the internal OpenClaw gateway token. Installers do not need to provide that credential.

For an existing pull Secret instead of a Helm-managed credential, set:

```yaml
global:
  imagePullSecrets:
    - name: existing-pull-secret
```

The chart patches the namespace `default` ServiceAccount through a Helm hook so OpenShell-created sandbox pods can pull the configured image.

## 2. Install On An NMC Admin Cluster

Run this flow from the BCM head node after setting `NGC_API_KEY` and `EXTERNAL_LLM_API_KEY`. It selects the NMC `k8s-admin` cluster, connects Mosaic to the existing `kube-prometheus-stack` services, and installs the AgentSandbox CRD and controller from the Mosaic chart.

```bash
module load kubernetes/k8s-admin

printf '%s' "$NGC_API_KEY" | helm registry login nvcr.io -u '$oauthtoken' --password-stdin
helm dependency build ./helm/mosaic-stack

kubectl create namespace mosaic --dry-run=client -o yaml | kubectl apply -f -
kubectl -n mosaic create secret generic mosaic-external-llm \
  --from-literal=apiKey="$EXTERNAL_LLM_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

GRAFANA_USERNAME=$(kubectl -n prometheus get secret kube-prometheus-stack-grafana -o jsonpath='{.data.admin-user}' | base64 -d)
GRAFANA_PASSWORD=$(kubectl -n prometheus get secret kube-prometheus-stack-grafana -o jsonpath='{.data.admin-password}' | base64 -d)
kubectl -n mosaic create secret generic mosaic-grafana-auth \
  --from-literal=username="$GRAFANA_USERNAME" \
  --from-literal=password="$GRAFANA_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install mosaic ./helm/mosaic-stack \
  -n mosaic \
  --create-namespace \
  --set global.registryCredentials.create=true \
  --set-string global.registryCredentials.password="$NGC_API_KEY" \
  --set-json 'namespace.labels={"zarf.dev/agent":"ignore"}' \
  --set llm.mode=external \
  --set llm.external.baseUrl=https://inference-api.nvidia.com/v1 \
  --set llm.external.model=aws/anthropic/bedrock-claude-sonnet-4-6 \
  --set llm.external.existingSecret=mosaic-external-llm \
  --set observability.prometheusUrl=http://kube-prometheus-stack-prometheus.prometheus.svc.cluster.local:9090 \
  --set observability.grafanaUrl=http://kube-prometheus-stack-grafana.prometheus.svc.cluster.local/grafana \
  --set observability.grafanaDatasourceUid=prometheus \
  --set observability.grafanaAuth.existingSecret=mosaic-grafana-auth \
  --set modules.slurm.enabled=false \
  --reset-values \
  --wait \
  --timeout 12m
```

## 3. LLM Modes

- `llm.mode=vllm`: deploys chart-managed vLLM. Use `helm/mosaic-stack/profiles/vllm-super-1gpu.yaml` for a small single-GPU profile or `helm/mosaic-stack/profiles/vllm-ultra-16gpu.yaml` for a larger distributed profile.
- `llm.mode=external`: does not deploy vLLM. Set `llm.external.baseUrl`, `llm.external.model`, and optionally `llm.external.existingSecret` plus `llm.external.apiKeySecretKey`.

For an external LLM, create the API key as a Kubernetes Secret outside Helm values, then point the chart at it:

```bash
kubectl create namespace mosaic --dry-run=client -o yaml | kubectl apply -f -
kubectl -n mosaic create secret generic mosaic-external-llm \
  --from-literal=apiKey='<external-llm-api-key>' \
  --dry-run=client -o yaml | kubectl apply -f -
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

## 4. Modules

`helm/mosaic-stack/values.yaml` exposes feature modules under `modules.*.enabled`. `modules.bcm.enabled` controls the BCM skill in the OpenClaw seed.

Observability is connected through explicit endpoints:

```yaml
observability:
  prometheusUrl: http://prometheus.mosaic-observability.svc.cluster.local:9090
  grafanaUrl: http://grafana.mosaic-observability.svc.cluster.local:3000/api/grafana/proxy
```

Those URLs may point at the reference `mosaic-observability` chart or at an existing Prometheus/Grafana deployment.

`grafanaUrl` includes Grafana's configured serving path. Use the service root for a root-served Grafana, `/grafana` for the NMC deployment, or `/api/grafana/proxy` for the bundled reference deployment.

## 5. Open The UI

```bash
kubectl -n mosaic port-forward svc/mosaic-ui 3000:3000
```

Open `http://localhost:3000`.

## 6. Headless Mode

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

The Slurm backend defaults to `auto`. When BCM and Slurm are both enabled, Mosaic uses BCM WLM's read-only job metadata, stdout, and stderr interface and does not deploy the node-local collector. Without BCM, Mosaic uses the vanilla collector. Set `modules.slurm.backend` to `bcm` or `vanilla` only to require one backend explicitly.

On BCM/NMC deployments, enable `bcmMcp` in `ssh-adapter` mode and provide the BCM head host and SSH-key Secret. The SSH identity must be allowed to create or update the dedicated read-only CMSH user during startup.

```yaml
bcmMcp:
  enabled: true
  mode: ssh-adapter
  headHost: bcm-head.example.com
  hostSshKeySecretName: bcm-host-ssh-key
modules:
  slurm:
    enabled: true
    backend: auto
```

## OpenShell Dependency

The chart declares a pinned OpenShell OCI dependency produced by `mosaic-upstream`. Run `helm dependency build ./helm/mosaic-stack` before installing from source. The pinned `kubernetes-sigs/agent-sandbox` prerequisite required by OpenShell's Kubernetes driver is tracked directly in this chart:

- `CustomResourceDefinition` resources are placed under chart `crds/` so Helm installs them before templates.
- The controller namespace, RBAC, service, and StatefulSet are rendered as normal templates when `agentSandbox.install=true`.

If a cluster already provides a compatible `agent-sandbox` installation, set:

```yaml
agentSandbox:
  install: false
```

Source installs from `./helm/mosaic-stack` include the tracked `agent-sandbox` CRD and controller templates.
