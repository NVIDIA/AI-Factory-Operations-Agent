# AI Factory Operations Agent Helm Deployment

AI Factory Operations Agent is installed with Helm. This guide documents the shared upgrade, LLM, module, UI, and headless workflows.

## Install AI Factory Operations Agent

For a bare Kubernetes cluster, follow the complete [Kind installation guide](../docs/kind_installation.md).

For an NVIDIA Mission Control managed cluster, follow the complete [NMC installation guide](../docs/nmc_installation.md).

## Custom Installation

### 1. Create The Namespace And Registry Access

```bash
MOSAIC_CHART=oci://nvcr.io/0948643769302270/mosaic-stack
# Remove --devel for the latest stable release, or replace it with --version 0.0.1 to pin that release.

read -rsp 'NGC API key: ' NGC_API_KEY; echo
printf '%s' "$NGC_API_KEY" | helm registry login nvcr.io \
  --username '$oauthtoken' \
  --password-stdin

kubectl create namespace mosaic --dry-run=client -o yaml | kubectl apply -f -
kubectl -n mosaic create secret docker-registry nvcr-image-pull-secret \
  --docker-server=nvcr.io \
  --docker-username='$oauthtoken' \
  --docker-password="$NGC_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

unset NGC_API_KEY
```

### 2. Choose An LLM

To install AI Factory Operations Agent with an external OpenAI-compatible LLM, set the provider URL and model, enter its API key, and run:

```bash
export EXTERNAL_LLM_BASE_URL='https://inference-api.nvidia.com/v1'
export EXTERNAL_LLM_MODEL='aws/anthropic/bedrock-claude-sonnet-4-6'
read -rsp 'External LLM API key: ' EXTERNAL_LLM_API_KEY; echo

kubectl -n mosaic create secret generic mosaic-external-llm \
  --from-literal=apiKey="$EXTERNAL_LLM_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install mosaic "$MOSAIC_CHART" \
  --devel \
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

AI Factory Operations Agent requests `reasoning_effort: none` from external endpoints. For an independently managed vLLM server, also set its server default:

```bash
vllm serve MODEL --default-chat-template-kwargs '{"enable_thinking":false}'
```

For chart-managed vLLM profiles, unpack the published chart once:

```bash
MOSAIC_CHART_WORKDIR=$(mktemp -d)
helm pull "$MOSAIC_CHART" \
  --devel \
  --untar \
  --untardir "$MOSAIC_CHART_WORKDIR"
MOSAIC_CHART_PATH="$MOSAIC_CHART_WORKDIR/mosaic-stack"
```

To install AI Factory Operations Agent with Nemotron Super running on 1 GPU in vLLM, run:

```bash
helm upgrade --install mosaic "$MOSAIC_CHART_PATH" \
  -n mosaic \
  -f "$MOSAIC_CHART_PATH/profiles/vllm-super-1gpu.yaml" \
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
  --timeout 30m
```

To install AI Factory Operations Agent with Nemotron Ultra running on 16 GPUs in vLLM, run:

```bash
helm upgrade --install mosaic "$MOSAIC_CHART_PATH" \
  -n mosaic \
  -f "$MOSAIC_CHART_PATH/profiles/vllm-ultra-16gpu.yaml" \
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
  --timeout 30m
```

After this point you will be able to open up the UI by running this:

```bash
kubectl -n mosaic port-forward svc/mosaic-ui 3000:3000
```

By default, the chart creates the `mosaic-ui-auth` Secret and generates both the UI password and an internal machine token. Leave `mosaicUi.auth.password` and `mosaicUi.auth.machineToken` empty; users do not need to provide either value. The generated credentials are preserved across upgrades.

Retrieve the browser login with:

```bash
kubectl -n mosaic get secret mosaic-ui-auth -o jsonpath='{.data.username}' | base64 --decode; echo
kubectl -n mosaic get secret mosaic-ui-auth -o jsonpath='{.data.password}' | base64 --decode; echo
```

`username` and `password` are browser credentials. `machineToken` is used automatically by OpenClaw when it calls protected AI Factory Operations Agent UI APIs; it is never entered in the browser.

`mosaicUi.auth.existingSecret` is only for installations that manage credentials outside this chart. When it is set, the chart does not create or modify the Secret, so the externally managed Secret must provide `username`, `password`, and `machineToken`.

Open `http://localhost:3000`.

### 3. Add Extensions

The minimal installation includes the UI, headless interfaces, OpenClaw, and OpenShell. Add only the extensions needed for the target cluster using the commands below.

## Extensions

All module changes below update an existing AI Factory Operations Agent release and preserve its current site configuration.

### Observability

To connect AI Factory Operations Agent to an existing Prometheus service, run:

```bash
export PROMETHEUS_URL='http://kube-prometheus-stack-prometheus.prometheus.svc.cluster.local:9090'
helm upgrade mosaic "$MOSAIC_CHART" \
  --devel \
  -n mosaic \
  --reuse-values \
  --set modules.observability.enabled=true \
  --set-string observability.prometheusUrl="$PROMETHEUS_URL" \
  --wait \
  --timeout 12m
```

### Alertmanager

AI Factory Operations Agent defaults to the Alertmanager service installed by NMC at `http://kube-prometheus-stack-alertmanager.prometheus.svc.cluster.local:9093`. To use another Alertmanager endpoint, run:

```bash
export ALERTMANAGER_URL='https://alerts.example.com/alertmanager'
helm upgrade mosaic "$MOSAIC_CHART" \
  --devel \
  -n mosaic \
  --reuse-values \
  --set-string observability.alertmanagerUrl="$ALERTMANAGER_URL" \
  --wait \
  --timeout 12m
```

`alertmanagerUrl` is the Alertmanager API base URL. AI Factory Operations Agent reads active alerts from its `/api/v2/alerts` endpoint.

### Grafana

To connect AI Factory Operations Agent to an existing Grafana service, run:

```bash
export GRAFANA_URL='http://kube-prometheus-stack-grafana.prometheus.svc.cluster.local/grafana'
export GRAFANA_DATASOURCE_UID='prometheus'
export GRAFANA_USERNAME='admin'
read -rsp 'Grafana password: ' GRAFANA_PASSWORD; echo

kubectl -n mosaic create secret generic mosaic-grafana-auth \
  --from-literal=username="$GRAFANA_USERNAME" \
  --from-literal=password="$GRAFANA_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade mosaic "$MOSAIC_CHART" \
  --devel \
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

`grafanaUrl` includes Grafana's configured serving path. Use the service root for a root-served Grafana or `/grafana` for the NMC deployment.

### Terminal

To enable the optional browser terminal service, run:

```bash
helm upgrade mosaic "$MOSAIC_CHART" \
  --devel \
  -n mosaic \
  --reuse-values \
  --set modules.terminal.enabled=true \
  --wait \
  --timeout 12m
```

### Access Modes

Enable guarded write operations with the Edit module:

```yaml
modules:
  edit:
    enabled: true
    hitl: true
    kubernetes:
      enabled: true
```

Every interactive conversation starts in **View**. Users can switch that conversation to **Edit** for approval-gated changes or **Auto** for validated changes without approval. Auto requires confirmation through a warning dialog. Other conversations remain in View, and automated alert and cluster-health sessions are always read-only. When the module is disabled, the access control is not shown.

Native Slack users remain read-only unless their verified Slack user ID is listed under `openclaw.slack.editUserIds`. Edit users approve their own mutations with Slack buttons. The broader `openclaw.slack.allowedUserIds` list controls who may use AI Factory Operations Agent through DMs, group DMs, and channel mentions.

Privileges are attached to separate tools and credentials. Read-only tools and the local and remote diagnostic command allowlist run automatically in View. Mutating Kubernetes, BCM, and SSH operations are blocked in View, approval-gated in Edit when `hitl: true`, and automatic in Auto. Kubernetes RBAC, request validation, configured SSH hosts, and audit logging apply in every mode.

Read [the AI Factory Operations Agent security model](../docs/security_model.md) before enabling Edit or Auto.

### BCM

To enable the BCM extension, provide the BCM head host and SSH key:

```bash
export BCM_HEAD_HOST='bcm-head.example.com'
export BCM_SSH_KEY_PATH='/root/.ssh/id_ecdsa'
test -r "$BCM_SSH_KEY_PATH"

kubectl -n mosaic create secret generic bcm-host-ssh-key \
  --from-file=id_ecdsa="$BCM_SSH_KEY_PATH" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade mosaic "$MOSAIC_CHART" \
  --devel \
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

To deploy the Research Agent and OpenSearch, set the embedding API key, active
model, and corpus path, then run:

```bash
read -rsp 'NVIDIA embedding API key: ' NVIDIA_API_KEY; echo
export IRAOP_API_KEY="$(openssl rand -hex 32)"
export MOSAIC_CHAT_MODEL='aws/anthropic/bedrock-claude-sonnet-4-6'
export IRA_CORPUS_PATH='/cm/shared/iraop-corpus'

kubectl -n mosaic create secret generic iraop-secrets \
  --from-literal=NVIDIA_API_KEY="$NVIDIA_API_KEY" \
  --from-literal=NVIDIA_CHAT_API_KEY=EMPTY \
  --from-literal=IRAOP_API_KEY="$IRAOP_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade mosaic "$MOSAIC_CHART" \
  --devel \
  -n mosaic \
  --reuse-values \
  --set modules.research.enabled=true \
  --set modules.research.secrets.create=false \
  --set-string researchAgent.iraop.config.NVIDIA_CHAT_MODEL="$MOSAIC_CHAT_MODEL" \
  --set-string researchAgent.iraop.corpus.hostPath="$IRA_CORPUS_PATH" \
  --wait \
  --timeout 12m

unset NVIDIA_API_KEY IRAOP_API_KEY
```

### Hardware Agent

The Hardware Agent reuses the BCM head address and `bcm-host-ssh-key` configured above. The chart exposes the required BCM lookup inside the cluster and generates its internal credentials. It uses NVDebug evidence and generic analysis.

```bash
helm upgrade mosaic "$MOSAIC_CHART" \
  --devel \
  -n mosaic \
  --reuse-values \
  --set modules.diagnostics.enabled=true \
  --wait \
  --timeout 12m

```

After installation the plugins of your choosing the installation process is done and you can reference the previous mentioned port-forward to open up the UI.

### Run:ai

The chart can deploy the public Run:ai MCP server and register its cluster-local
endpoint with OpenClaw through the standard MCP configuration. Run:ai client
credentials are mounted only in the MCP server pod, and write tools are disabled.

```bash
kubectl -n mosaic create secret generic runai-credentials \
  --from-literal=clientId="$RUNAI_CLIENT_ID" \
  --from-literal=clientSecret="$RUNAI_CLIENT_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade mosaic "$MOSAIC_CHART" \
  --devel \
  -n mosaic \
  --reuse-values \
  --set modules.runai.enabled=true \
  --set-string runaiMcp.baseUrl="https://runai.example.com" \
  --set runaiMcp.credentials.existingSecret=runai-credentials \
  --wait \
  --timeout 12m
```

For a Run:ai endpoint signed by a private CA, create a Secret containing
`ca.crt` and set `runaiMcp.tls.existingSecret` to its name.

## Upgrade An Existing Installation

Retain the working site configuration with:

```bash
MOSAIC_CHART=oci://nvcr.io/0948643769302270/mosaic-stack
# Remove --devel for the latest stable release, or replace it with --version 0.0.1 to pin that release.
helm upgrade mosaic "$MOSAIC_CHART" \
  --devel \
  -n mosaic \
  --reuse-values \
  --atomic \
  --wait \
  --timeout 12m
```

If Helm is not already authenticated to NVCR, run the registry login command from custom installation step 1 first.

## Headless Mode

The AI Factory Operations Agent UI service also exposes a headless API:

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

The AI Factory Operations Agent HTTP service is not itself an MCP endpoint. Install the stdio MCP bridge on the client machine (Node.js 18 or newer is required):

```bash
git clone https://github.com/NVIDIA/AI-Factory-Operations-Agent.git
cd AI-Factory-Operations-Agent
install -d ~/.local/bin
install -m 0755 utils/mosaic-mcp.mjs ~/.local/bin/mosaic-mcp
```

Point the bridge at any reachable AI Factory Operations Agent UI URL. For Claude Code:

```bash
claude mcp add mosaic \
  -e MOSAIC_URL=http://localhost:3000 \
  -- ~/.local/bin/mosaic-mcp
```

For Codex:

```bash
codex mcp add mosaic \
  --env MOSAIC_URL=http://localhost:3000 \
  -- ~/.local/bin/mosaic-mcp
```

Replace `http://localhost:3000` with the deployed AI Factory Operations Agent URL when it is reachable directly. The bridge exposes `ai_factory_operations_agent_chat`, `ai_factory_operations_agent_history`, `ai_factory_operations_agent_commands`, and the AI Factory Operations Agent/OpenClaw tools enabled by the chart over stdio MCP. See `docs/skills/ai-factory-operations-agent-headless/SKILL.md` for the complete agent workflow.

## Vanilla Slurm RCA

The public Slurm workflow is evidence based. By default, the chart deploys a read-only Slurm evidence collector. The collector mounts the host filesystem read-only inside the collector pod, exposes bounded HTTP tools to OpenClaw, and keeps broad host filesystem access out of the LLM sandbox.

Default collector roots:

- `/var/log`
- `/cm/shared`
- `/slurm`
- `/etc/slurm`
- `/cm/shared/apps/slurm/etc`
- `/run/log/journal`
- `/var/log/journal`

The Slurm skill first calls `slurm_job_evidence`, then falls back to read-only `sacct`/`scontrol` and any mounted evidence available in the sandbox. Missing paths are expected on many clusters; the skill continues with whatever evidence is present.

To use the vanilla collector with a site-specific evidence root, run:

```bash
export SLURM_EVIDENCE_ROOT='/shared/slurm'
helm upgrade mosaic "$MOSAIC_CHART" \
  --devel \
  -n mosaic \
  --reuse-values \
  --set modules.slurm.enabled=true \
  --set modules.slurm.backend=vanilla \
  --set-json "slurmEvidenceCollector.roots=[\"$SLURM_EVIDENCE_ROOT\"]" \
  --wait \
  --timeout 12m
```

The Slurm backend defaults to `auto`. When BCM and Slurm are both enabled, AI Factory Operations Agent uses BCM WLM's read-only job metadata, stdout, and stderr interface and does not deploy the node-local collector. Without BCM, it uses the vanilla collector. Set `modules.slurm.backend` to `bcm` or `vanilla` only to require one backend explicitly.

After enabling the BCM extension, enable BCM-backed Slurm with:

```bash
helm upgrade mosaic "$MOSAIC_CHART" \
  --devel \
  -n mosaic \
  --reuse-values \
  --set modules.slurm.enabled=true \
  --set modules.slurm.backend=auto \
  --wait \
  --timeout 12m
```

## Kubernetes Access

AI Factory Operations Agent exposes one read-only OpenClaw tool, `run_kubectl`. The tool invokes a pinned kubectl binary with an argument array, never a shell command. It rejects mutation, pod execution, port forwarding, Secret reads, impersonation, raw kubeconfig output, and credential or API endpoint overrides before launching kubectl. Kubernetes RBAC independently denies those operations.

The local cluster is registered by default using the `openclaw` ServiceAccount. Its token and kubeconfig are mounted only in the OpenClaw pod; OpenShell sandboxes receive neither Kubernetes credentials nor kubectl.

Enable read-only access to the local cluster with:

```bash
helm upgrade mosaic "$MOSAIC_CHART" \
  --devel \
  -n mosaic \
  --reuse-values \
  --set modules.kubernetes.enabled=true \
  --wait \
  --timeout 12m
```

To register another cluster, first create a kubeconfig for a read-only identity on that cluster. Store it as a Secret in the AI Factory Operations Agent namespace:

```bash
kubectl -n mosaic create secret generic production-west-kubeconfig \
  --from-file=config=/path/to/read-only-kubeconfig
```

Register that Secret with AI Factory Operations Agent by running:

```bash
helm upgrade mosaic "$MOSAIC_CHART" \
  --devel \
  -n mosaic \
  --reuse-values \
  --set modules.kubernetes.enabled=true \
  --set-json 'kubernetes.clusters=[{"name":"production-west","kubeconfigSecretRef":{"name":"production-west-kubeconfig","key":"config"}}]' \
  --wait \
  --timeout 12m
```

The model selects only the registered name. It cannot provide a kubeconfig path, context, token, or server address. Removing the list entry on upgrade removes the corresponding credential mount. A missing Secret leaves the OpenClaw pod unready with the Kubernetes volume error from the kubelet.

## OpenShell Dependency

The published chart includes the pinned official OpenShell OCI dependency from `ghcr.io/nvidia/openshell`. It uses the official gateway, supervisor, and unprivileged base sandbox images. The pinned `kubernetes-sigs/agent-sandbox` prerequisite required by OpenShell's Kubernetes driver is included as well:

- `CustomResourceDefinition` resources are placed under chart `crds/` so Helm installs them before templates.
- The controller namespace, RBAC, service, and StatefulSet are rendered as normal templates when `agentSandbox.install=true`.

If the cluster already provides a compatible `agent-sandbox` installation, run:

```bash
helm upgrade mosaic "$MOSAIC_CHART" \
  --devel \
  -n mosaic \
  --reuse-values \
  --set agentSandbox.install=false \
  --wait \
  --timeout 12m
```

The packaged chart includes the tracked `agent-sandbox` CRD and controller templates.
