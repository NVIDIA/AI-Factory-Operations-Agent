# Mosaic Helm Deployment

Mosaic is installed with Helm. This guide documents the shared upgrade, LLM, module, UI, and headless workflows.

## Install Mosaic

For a bare Kubernetes cluster, follow the complete [Kind installation guide](../docs/kind_installation.md).

For an NVIDIA Mission Control managed cluster, follow the complete [NMC installation guide](../docs/nmc_installation.md).

## Custom Installation

### 1. Create The Namespace And Registry Access

```bash
read -rsp 'NGC API key: ' NGC_API_KEY; echo
printf '%s' "$NGC_API_KEY" | helm registry login nvcr.io \
  --username '$oauthtoken' \
  --password-stdin

helm dependency build ./helm/mosaic-stack

kubectl create namespace mosaic --dry-run=client -o yaml | kubectl apply -f -
kubectl -n mosaic create secret docker-registry nvcr-image-pull-secret \
  --docker-server=nvcr.io \
  --docker-username='$oauthtoken' \
  --docker-password="$NGC_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

unset NGC_API_KEY
```

### 2. Choose An LLM

To install Mosaic with an external OpenAI-compatible LLM, set the provider URL and model, enter its API key, and run:

```bash
export EXTERNAL_LLM_BASE_URL='https://inference-api.nvidia.com/v1'
export EXTERNAL_LLM_MODEL='aws/anthropic/bedrock-claude-sonnet-4-6'
read -rsp 'External LLM API key: ' EXTERNAL_LLM_API_KEY; echo

kubectl -n mosaic create secret generic mosaic-external-llm \
  --from-literal=apiKey="$EXTERNAL_LLM_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install mosaic ./helm/mosaic-stack \
  -n mosaic \
  --set 'global.imagePullSecrets[0].name=nvcr-image-pull-secret' \
  --set llm.mode=external \
  --set-string llm.external.baseUrl="$EXTERNAL_LLM_BASE_URL" \
  --set-string llm.external.model="$EXTERNAL_LLM_MODEL" \
  --set llm.external.existingSecret=mosaic-external-llm \
  --set modules.ui.enabled=true \
  --set modules.execution.enabled=true \
  --set modules.kubernetes.enabled=false \
  --set modules.observability.enabled=false \
  --set modules.grafana.enabled=false \
  --set modules.bcm.enabled=false \
  --set modules.slurm.enabled=false \
  --set modules.diagnostics.enabled=false \
  --set modules.research.enabled=false \
  --set modules.terminal.enabled=false \
  --set-string openclaw.pvc.storageClassName='' \
  --set-string mosaicUi.auditPvc.storageClassName='' \
  --reset-values \
  --atomic \
  --wait \
  --timeout 12m

unset EXTERNAL_LLM_API_KEY
```

For OpenAI, use `EXTERNAL_LLM_BASE_URL=https://api.openai.com/v1` and a model available to the account. Do not put provider keys in committed values files.

To install Mosaic with Nemotron Super running on 1 GPU in vLLM, run:

```bash
helm upgrade --install mosaic ./helm/mosaic-stack \
  -n mosaic \
  -f helm/mosaic-stack/profiles/vllm-super-1gpu.yaml \
  --set 'global.imagePullSecrets[0].name=nvcr-image-pull-secret' \
  --set modules.ui.enabled=true \
  --set modules.execution.enabled=true \
  --set modules.kubernetes.enabled=false \
  --set modules.observability.enabled=false \
  --set modules.grafana.enabled=false \
  --set modules.bcm.enabled=false \
  --set modules.slurm.enabled=false \
  --set modules.diagnostics.enabled=false \
  --set modules.research.enabled=false \
  --set modules.terminal.enabled=false \
  --set-string openclaw.pvc.storageClassName='' \
  --set-string mosaicUi.auditPvc.storageClassName='' \
  --reset-values \
  --atomic \
  --wait \
  --timeout 12m
```

To install Mosaic with Nemotron Ultra running on 16 GPUs in vLLM, run:

```bash
helm upgrade --install mosaic ./helm/mosaic-stack \
  -n mosaic \
  -f helm/mosaic-stack/profiles/vllm-ultra-16gpu.yaml \
  --set 'global.imagePullSecrets[0].name=nvcr-image-pull-secret' \
  --set modules.ui.enabled=true \
  --set modules.execution.enabled=true \
  --set modules.kubernetes.enabled=false \
  --set modules.observability.enabled=false \
  --set modules.grafana.enabled=false \
  --set modules.bcm.enabled=false \
  --set modules.slurm.enabled=false \
  --set modules.diagnostics.enabled=false \
  --set modules.research.enabled=false \
  --set modules.terminal.enabled=false \
  --set-string openclaw.pvc.storageClassName='' \
  --set-string mosaicUi.auditPvc.storageClassName='' \
  --reset-values \
  --atomic \
  --wait \
  --timeout 12m
```

After this point you will be able to open up the UI by running this:

```bash
kubectl -n mosaic port-forward svc/mosaic-ui 3000:3000
```

Open `http://localhost:3000`.

### 3. Add Extensions

The minimal installation includes the UI, headless interfaces, OpenClaw, and OpenShell. Add only the extensions needed for the target cluster using the commands below.

## Extensions

All module changes below update an existing Mosaic release and preserve its current site configuration.

### Observability

To connect Mosaic to an existing Prometheus service, run:

```bash
export PROMETHEUS_URL='http://prometheus.mosaic-observability.svc.cluster.local:9090'
helm upgrade mosaic ./helm/mosaic-stack \
  -n mosaic \
  --reuse-values \
  --set modules.observability.enabled=true \
  --set-string observability.prometheusUrl="$PROMETHEUS_URL" \
  --wait \
  --timeout 12m
```

### Grafana

To connect Mosaic to an existing Grafana service, run:

```bash
export GRAFANA_URL='http://grafana.mosaic-observability.svc.cluster.local:3000/api/grafana/proxy'
export GRAFANA_DATASOURCE_UID='mosaic-observability-prometheus'
export GRAFANA_USERNAME='admin'
read -rsp 'Grafana password: ' GRAFANA_PASSWORD; echo

kubectl -n mosaic create secret generic mosaic-grafana-auth \
  --from-literal=username="$GRAFANA_USERNAME" \
  --from-literal=password="$GRAFANA_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade mosaic ./helm/mosaic-stack \
  -n mosaic \
  --reuse-values \
  --set modules.grafana.enabled=true \
  --set-string observability.grafanaUrl="$GRAFANA_URL" \
  --set-string observability.grafanaDatasourceUid="$GRAFANA_DATASOURCE_UID" \
  --set observability.grafanaAuth.existingSecret=mosaic-grafana-auth \
  --wait \
  --timeout 12m

unset GRAFANA_PASSWORD
```

`grafanaUrl` includes Grafana's configured serving path. Use the service root for a root-served Grafana, `/grafana` for the NMC deployment, or `/api/grafana/proxy` for the bundled reference deployment.

### Terminal

To enable the optional browser terminal service, run:

```bash
helm upgrade mosaic ./helm/mosaic-stack \
  -n mosaic \
  --reuse-values \
  --set modules.terminal.enabled=true \
  --wait \
  --timeout 12m
```

### BCM

To enable the BCM extension, provide the BCM head host and SSH key:

```bash
export BCM_HEAD_HOST='bcm-head.example.com'
export BCM_SSH_KEY_PATH='/root/.ssh/id_ecdsa'
test -r "$BCM_SSH_KEY_PATH"

kubectl -n mosaic create secret generic bcm-host-ssh-key \
  --from-file=id_ecdsa="$BCM_SSH_KEY_PATH" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade mosaic ./helm/mosaic-stack \
  -n mosaic \
  --reuse-values \
  --set modules.bcm.enabled=true \
  --set bcmMcp.enabled=true \
  --set bcmMcp.mode=ssh-adapter \
  --set-string bcmMcp.headHost="$BCM_HEAD_HOST" \
  --set bcmMcp.hostSshKeySecretName=bcm-host-ssh-key \
  --wait \
  --timeout 12m
```

The SSH identity must be allowed to create or update the dedicated read-only CMSH user during startup.

### Research

To connect the Research module to an existing IRA MCP SSE endpoint, run:

```bash
export IRA_MCP_URL='http://iraop.research.svc.cluster.local:8000/mcp/sse'
helm upgrade mosaic ./helm/mosaic-stack \
  -n mosaic \
  --reuse-values \
  --set modules.research.enabled=true \
  --set modules.research.managed=false \
  --set-string modules.research.baseUrl="$IRA_MCP_URL" \
  --wait \
  --timeout 12m
```

To deploy the chart-managed Research Agent and OpenSearch, set the embedding API key, active Mosaic model, and corpus path, then run:

```bash
read -rsp 'NVIDIA embedding API key: ' NVIDIA_API_KEY; echo
export MOSAIC_CHAT_MODEL='aws/anthropic/bedrock-claude-sonnet-4-6'
export IRA_CORPUS_PATH='/cm/shared/iraop-corpus'

kubectl -n mosaic create secret generic iraop-secrets \
  --from-literal=NVIDIA_API_KEY="$NVIDIA_API_KEY" \
  --from-literal=NVIDIA_CHAT_API_KEY=EMPTY \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade mosaic ./helm/mosaic-stack \
  -n mosaic \
  --reuse-values \
  --set modules.research.enabled=true \
  --set modules.research.managed=true \
  --set modules.research.secrets.create=false \
  --set-string researchAgent.iraop.config.NVIDIA_CHAT_MODEL="$MOSAIC_CHAT_MODEL" \
  --set-string researchAgent.iraop.corpus.hostPath="$IRA_CORPUS_PATH" \
  --wait \
  --timeout 12m

unset NVIDIA_API_KEY
```

### Hardware Agent

Provide its API keys, BCM webhook credentials, BCM SSH key, NVDebug playbook archive, and additional environment variables:

```bash
export DIAGNOSTIC_API_KEYS='<comma-separated-agent-api-keys>'
export BCM_WEBHOOK_URL='<bcm-webhook-url>'
read -rsp 'BCM webhook token: ' BCM_WEBHOOK_TOKEN; echo
export BCM_SSH_KEY_PATH='/root/.ssh/id_ecdsa'
export NVDEBUG_PLAYBOOKS_TGZ='/path/to/playbooks.tgz'
export DIAGNOSTIC_ENV_FILE='/path/to/diagnostic-agent.env'

test -r "$BCM_SSH_KEY_PATH"
test -r "$NVDEBUG_PLAYBOOKS_TGZ"
test -r "$DIAGNOSTIC_ENV_FILE"
kubectl -n mosaic create secret generic diagnostic-agent-api-keys \
  --from-literal=AGENT_API_KEYS="$DIAGNOSTIC_API_KEYS" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n mosaic create secret generic bcm-webhook-creds \
  --from-literal=BCM_WEBHOOK_URL="$BCM_WEBHOOK_URL" \
  --from-literal=BCM_WEBHOOK_TOKEN="$BCM_WEBHOOK_TOKEN" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n mosaic create secret generic diagnostic-agent-secrets \
  --from-env-file="$DIAGNOSTIC_ENV_FILE" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n mosaic create secret generic bcm-host-ssh-key \
  --from-file=id_ecdsa="$BCM_SSH_KEY_PATH" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n mosaic create configmap debughub-playbooks-tar \
  --from-file=playbooks.tgz="$NVDEBUG_PLAYBOOKS_TGZ" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade mosaic ./helm/mosaic-stack \
  -n mosaic \
  --reuse-values \
  --set modules.diagnostics.enabled=true \
  --wait \
  --timeout 12m

unset BCM_WEBHOOK_TOKEN
```

After installation the plugins of your choosing the installation process is done and you can reference the previous mentioned port-forward to open up the UI.

## Upgrade An Existing Installation

After pulling the latest tracked source, retain the working site configuration with:

```bash
helm dependency build ./helm/mosaic-stack
helm upgrade mosaic ./helm/mosaic-stack \
  -n mosaic \
  --reuse-values \
  --atomic \
  --wait \
  --timeout 12m
```

If Helm is not already authenticated to NVCR, run the registry login command from custom installation step 1 first.

## Headless Mode

The Mosaic UI service also exposes a headless API:

```bash
curl -sS http://localhost:3000/api/headless/chat \
  -H 'content-type: application/json' \
  -d '{"prompt":"summarize whether the cluster is healthy","sessionKey":"headless"}'
```

Invoke the packaged CLI inside the `mosaic-ui` pod with:

```bash
kubectl -n mosaic exec deploy/mosaic-ui -- \
  mosaic --session headless "summarize whether the cluster is healthy"
```

Register the packaged MCP server with Codex by running:

```bash
codex mcp add mosaic -- \
  kubectl -n mosaic exec -i deploy/mosaic-ui -- \
  env MOSAIC_URL=http://127.0.0.1:3000 mosaic-mcp
```

It exposes `mosaic_chat`, `mosaic_history`, `mosaic_commands`, and the Mosaic/OpenClaw tools enabled by the chart over stdio MCP. See `docs/skills/mosaic-headless/SKILL.md` for the complete agent workflow.

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

The Slurm skill first calls `slurm_job_evidence`, then falls back to read-only `sacct`/`scontrol` and any mounted evidence available in the sandbox. Missing paths are expected on many clusters; the skill continues with whatever evidence is present.

To use the vanilla collector with a site-specific evidence root, run:

```bash
export SLURM_EVIDENCE_ROOT='/shared/slurm'
helm upgrade mosaic ./helm/mosaic-stack \
  -n mosaic \
  --reuse-values \
  --set modules.slurm.enabled=true \
  --set modules.slurm.backend=vanilla \
  --set-json "slurmEvidenceCollector.roots=[\"$SLURM_EVIDENCE_ROOT\"]" \
  --wait \
  --timeout 12m
```

The Slurm backend defaults to `auto`. When BCM and Slurm are both enabled, Mosaic uses BCM WLM's read-only job metadata, stdout, and stderr interface and does not deploy the node-local collector. Without BCM, Mosaic uses the vanilla collector. Set `modules.slurm.backend` to `bcm` or `vanilla` only to require one backend explicitly.

After enabling the BCM extension, enable BCM-backed Slurm with:

```bash
helm upgrade mosaic ./helm/mosaic-stack \
  -n mosaic \
  --reuse-values \
  --set modules.slurm.enabled=true \
  --set modules.slurm.backend=auto \
  --wait \
  --timeout 12m
```

## Kubernetes Access

Mosaic exposes one read-only OpenClaw tool, `run_kubectl`. The tool invokes a pinned kubectl binary with an argument array, never a shell command. It rejects mutation, pod execution, port forwarding, Secret reads, impersonation, raw kubeconfig output, and credential or API endpoint overrides before launching kubectl. Kubernetes RBAC independently denies those operations.

The local cluster is registered by default using the `openclaw` ServiceAccount. Its token and kubeconfig are mounted only in the OpenClaw pod; OpenShell sandboxes receive neither Kubernetes credentials nor kubectl.

Enable read-only access to the local cluster with:

```bash
helm upgrade mosaic ./helm/mosaic-stack \
  -n mosaic \
  --reuse-values \
  --set modules.kubernetes.enabled=true \
  --wait \
  --timeout 12m
```

To register another cluster, first create a kubeconfig for a read-only identity on that cluster. Store it as a Secret in the Mosaic namespace:

```bash
kubectl -n mosaic create secret generic production-west-kubeconfig \
  --from-file=config=/path/to/read-only-kubeconfig
```

Register that Secret with Mosaic by running:

```bash
helm upgrade mosaic ./helm/mosaic-stack \
  -n mosaic \
  --reuse-values \
  --set modules.kubernetes.enabled=true \
  --set-json 'kubernetes.clusters=[{"name":"production-west","kubeconfigSecretRef":{"name":"production-west-kubeconfig","key":"config"}}]' \
  --wait \
  --timeout 12m
```

The model selects only the registered name. It cannot provide a kubeconfig path, context, token, or server address. Removing the list entry on upgrade removes the corresponding credential mount. A missing Secret leaves the OpenClaw pod unready with the Kubernetes volume error from the kubelet.

## OpenShell Dependency

The chart declares the pinned official OpenShell OCI dependency from `ghcr.io/nvidia/openshell`. It uses the official gateway, supervisor, and unprivileged base sandbox images. Run `helm dependency build ./helm/mosaic-stack` before installing from source. The pinned `kubernetes-sigs/agent-sandbox` prerequisite required by OpenShell's Kubernetes driver is tracked directly in this chart:

- `CustomResourceDefinition` resources are placed under chart `crds/` so Helm installs them before templates.
- The controller namespace, RBAC, service, and StatefulSet are rendered as normal templates when `agentSandbox.install=true`.

If the cluster already provides a compatible `agent-sandbox` installation, run:

```bash
helm upgrade mosaic ./helm/mosaic-stack \
  -n mosaic \
  --reuse-values \
  --set agentSandbox.install=false \
  --wait \
  --timeout 12m
```

Source installs from `./helm/mosaic-stack` include the tracked `agent-sandbox` CRD and controller templates.
