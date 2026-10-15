# NMC Installation

This guide installs AI Factory Operations Agent on an NVIDIA Mission Control admin cluster. For upgrades, verification, LLM configuration, module reference, UI access, and headless usage, see the [shared Helm guide](installation.md).

For self-hosted inference on the separate GPU workload cluster, first follow [Self-hosted inference](#self-hosted-inference), then use its endpoint, served model name, and API key below. The bundled vLLM profile requires GPUs in the same cluster as the agent and should not be used on a GPU-free admin cluster.

## Install the agent

Run this flow from the Base Command Manager head node after setting `NGC_API_KEY`, `EXTERNAL_LLM_API_KEY`, `EXTERNAL_LLM_BASE_URL`, and `EXTERNAL_LLM_MODEL`. The endpoint, model, and API key must belong to the same OpenAI-compatible provider. For OpenAI, use `https://api.openai.com/v1` and a model available to that account.

Use an NGC account invited to the `afoa-release` team. Accept the invitation while signed in with that account, then create a personal API key with the Private Registry service in [NGC Setup > API Keys](https://org.ngc.nvidia.com/setup/api-keys). Save the key when shown; NGC displays it only once. Run the installation in a login shell with `module load` available.

The command selects the NMC `k8s-admin` cluster, connects AI Factory Operations Agent to the existing `kube-prometheus-stack` services, enables Slurm through Base Command Manager, and installs the AgentSandbox CRD and controller from the chart.

```bash
set -euo pipefail
module load kubernetes/k8s-admin

: "${NGC_API_KEY:?Set NGC_API_KEY to an NGC API key with private registry access}"
: "${EXTERNAL_LLM_API_KEY:?Set EXTERNAL_LLM_API_KEY for the selected provider}"
: "${EXTERNAL_LLM_BASE_URL:?Set EXTERNAL_LLM_BASE_URL for the selected provider}"
: "${EXTERNAL_LLM_MODEL:?Set EXTERNAL_LLM_MODEL for the selected provider}"
MOSAIC_NAMESPACE=${MOSAIC_NAMESPACE:-mosaic}
MOSAIC_CHART=oci://nvcr.io/0948643769302270/afoa-release/mosaic-stack
CLUSTER_MANAGER_HEAD_HOST=${CLUSTER_MANAGER_HEAD_HOST:-$(hostname -s)}
CLUSTER_MANAGER_SSH_KEY_PATH=${CLUSTER_MANAGER_SSH_KEY_PATH:-/root/.ssh/id_ecdsa}

test -r "$CLUSTER_MANAGER_SSH_KEY_PATH"
kubectl cluster-info >/dev/null
kubectl auth can-i create deployments -n "$MOSAIC_NAMESPACE" | grep -qx yes
kubectl -n prometheus get secret kube-prometheus-stack-grafana >/dev/null
cmsh -c 'wlm; list' | grep -qi slurm

printf '%s' "$NGC_API_KEY" | helm registry login nvcr.io \
  --username '$oauthtoken' \
  --password-stdin

kubectl create namespace "$MOSAIC_NAMESPACE" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$MOSAIC_NAMESPACE" create secret generic mosaic-external-llm \
  --from-literal=apiKey="$EXTERNAL_LLM_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$MOSAIC_NAMESPACE" create secret generic bcm-host-ssh-key \
  --from-file=id_ecdsa="$CLUSTER_MANAGER_SSH_KEY_PATH" \
  --dry-run=client -o yaml | kubectl apply -f -

GRAFANA_USERNAME=$(kubectl -n prometheus get secret kube-prometheus-stack-grafana -o jsonpath='{.data.admin-user}' | base64 -d)
GRAFANA_PASSWORD=$(kubectl -n prometheus get secret kube-prometheus-stack-grafana -o jsonpath='{.data.admin-password}' | base64 -d)
kubectl -n "$MOSAIC_NAMESPACE" create secret generic mosaic-grafana-auth \
  --from-literal=username="$GRAFANA_USERNAME" \
  --from-literal=password="$GRAFANA_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

# Remove --devel for the latest stable release, or replace it with --version 0.0.1 to pin that release.
helm upgrade --install mosaic "$MOSAIC_CHART" \
  --devel \
  -n "$MOSAIC_NAMESPACE" \
  --create-namespace \
  --set global.registryCredentials.create=true \
  --set-string global.registryCredentials.password="$NGC_API_KEY" \
  --set-json 'namespace.labels={"zarf.dev/agent":"ignore"}' \
  --set llm.mode=external \
  --set-string llm.external.baseUrl="$EXTERNAL_LLM_BASE_URL" \
  --set-string llm.external.model="$EXTERNAL_LLM_MODEL" \
  --set llm.external.existingSecret=mosaic-external-llm \
  --set observability.prometheusUrl=http://kube-prometheus-stack-prometheus.prometheus.svc.cluster.local:9090 \
  --set observability.grafanaUrl=http://kube-prometheus-stack-grafana.prometheus.svc.cluster.local/grafana \
  --set observability.grafanaDatasourceUid=prometheus \
  --set observability.grafanaAuth.existingSecret=mosaic-grafana-auth \
  --set modules.bcm.enabled=true \
  --set bcmMcp.enabled=true \
  --set bcmMcp.mode=ssh-adapter \
  --set-string bcmMcp.headHost="$CLUSTER_MANAGER_HEAD_HOST" \
  --set bcmMcp.hostSshKeySecretName=bcm-host-ssh-key \
  --set modules.slurm.enabled=true \
  --set modules.slurm.backend=auto \
  --reset-values \
  --wait \
  --timeout 12m
```

The command is a complete declaration and can be rerun unchanged. The SSH private key remains in the `bcm-host-ssh-key` Kubernetes Secret and is mounted only into the Base Command Manager adapter pod. On the first generic Base Command Manager MCP request, the adapter installs its matching remote server version on the Base Command Manager head automatically. With both modules enabled, the Slurm skill selects Base Command Manager WLM access instead of host-mounted vanilla evidence.

Before following the shared upgrade workflow in a new shell, run `module load kubernetes/k8s-admin` to select the NMC admin cluster.

## Self-hosted inference

Deploy inference in `k8s-user` and connect the agent in `k8s-admin` to its HTTPS endpoint. If you already have an OpenAI-compatible endpoint, skip to [Install the agent](#install-the-agent).

### 1. Configure inference

Run from a checkout of this repository. The example chart is at `helm/afoa-inference`; it is separate from the published agent chart. You need:

- A compatible GPU in `k8s-user`, the NVIDIA device plugin and a GPU runtime. The default [Nemotron Super profile](https://huggingface.co/nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4) requests one GPU, 8 CPUs, 64 GiB host memory and a 500 GiB persistent cache. Check the model card for GPU memory and driver requirements.
- A StorageClass for the cache, plus access to the vLLM image and model weights.
- An internal ingress controller, DNS name and TLS Secret. Admin-cluster pods must be able to reach that hostname on port 443 and trust its certificate.

Create `inference-values.yaml`, replacing these placeholders:

```yaml
ingress:
  enabled: true
  className: nginx
  host: inference.example.com
  tlsSecretName: inference-tls
```

### 2. Deploy in `k8s-user`

Choose an inference API key and save it in your credential store. This same key will be used by the agent; it is separate from NGC and model-download credentials.

```bash
module load kubernetes/k8s-user
read -rsp 'Self-hosted inference API key: ' EXTERNAL_LLM_API_KEY; echo
kubectl create namespace afoa-inference --dry-run=client -o yaml | kubectl apply -f -
kubectl -n afoa-inference create secret generic afoa-inference-auth \
  --from-literal=apiKey="$EXTERNAL_LLM_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install afoa-inference ./helm/afoa-inference \
  -n afoa-inference \
  -f inference-values.yaml \
  --wait \
  --timeout 2h
```

The first download and GPU kernel compilation can take more than 30 minutes. Wait for Helm to finish; startup checks are below.

### 3. Connect the agent

```bash
export EXTERNAL_LLM_BASE_URL='https://inference.example.com/v1'
export EXTERNAL_LLM_MODEL='nemotron-super-120b'
module load kubernetes/k8s-admin
```

Continue with [Install the agent](#install-the-agent), using the same inference key. `llm.mode=external` connects to your self-hosted endpoint. After installation, [open the UI](installation.md#usage) and send a short question.

Use the ingress hostname with `/v1`, rather than a cross-cluster `*.svc.cluster.local` address. If you changed `servedModelName`, use that name as `EXTERNAL_LLM_MODEL`. For an existing installation, use the provider-switch instructions below.

<details>
<summary>Site-specific GPU, storage and TLS settings</summary>

- Set `runtimeClassName` to your GPU runtime, or an empty string if the default runtime supports GPUs. Use `nodeSelector` for compatible hardware in a mixed cluster.
- Set `modelCache.storageClassName` for a non-default StorageClass. Keep cache size unchanged during upgrades: a normal Helm upgrade cannot resize the StatefulSet volume claim template.
- For restricted model downloads, set `modelToken.existingSecret`. Airgapped sites need an image mirror and a populated model cache.
- For a site CA, store its certificate in an admin-namespace Secret and set `llm.external.caCertificateSecret` on the agent chart (default key `ca.crt`; configurable with `caCertificateKey`). The agent and compatibility proxy add it to their normal trust stores. The inference chart does not create certificates or install an ingress controller; configure HTTPS redirects and streaming timeouts on your controller.
- In Run:ai-managed environments, ensure the target namespace has sufficient GPU quota.

The ingress exposes only `/v1`. Keep the backend Service on a trusted network because vLLM's API key does not protect every server endpoint. See [vLLM security guidance](https://docs.vllm.ai/en/latest/usage/security/).

See the [NMC Kubernetes installation guide](https://docs.nvidia.com/mission-control/docs/nmc-software-installation-guide/2.3.1/airgapped-installation/install-k8s.html) for cluster setup. Confirm your site's GPU membership before deploying; the bundled agent vLLM profiles require GPUs in the agent's own cluster.

</details>

<details>
<summary>Switch an existing agent to the new endpoint</summary>

For an existing installation, update only its provider settings, retaining enabled modules and site configuration. Use the same chart version already installed, or the explicitly selected upgrade version. `AGENT_CHART_VERSION` below must be set to that version; `AGENT_CHART` is the chart reference from the NMC guide.

First check the new endpoint from the existing agent pod, streaming the self-hosted key through stdin without changing its configuration:

```bash
printf '%s' "$EXTERNAL_LLM_API_KEY" | \
kubectl -n "${AGENT_NAMESPACE:?Set the existing agent namespace}" exec -i deployment/openclaw -c gateway -- \
  node --input-type=module -e '
let key = "";
for await (const chunk of process.stdin) key += chunk;
const response = await fetch(`${process.argv[1].replace(/\/$/, "")}/chat/completions`, {
  method: "POST",
  headers: {Authorization: `Bearer ${key}`, "Content-Type": "application/json"},
  body: JSON.stringify({model: process.argv[2], messages: [{role: "user", content: "Reply with ready."}], max_tokens: 32}),
  signal: AbortSignal.timeout(120000),
});
console.log(`Inference check: HTTP ${response.status}`);
if (!response.ok) process.exit(1);
' "$EXTERNAL_LLM_BASE_URL" "$EXTERNAL_LLM_MODEL"
```

Proceed after HTTP 200. Create a separate client Secret so the existing provider's Secret stays intact until the switch:

```bash
: "${AGENT_CHART_VERSION:?Set the intended chart version}"
: "${EXTERNAL_LLM_API_KEY:?Load the self-hosted key from your protected store}"
: "${AGENT_NAMESPACE:?Set the existing agent namespace}"
: "${AGENT_RELEASE:?Set the existing agent Helm release}"
: "${AGENT_CHART:?Set the existing agent chart reference}"
kubectl -n "$AGENT_NAMESPACE" create secret generic afoa-inference-client \
  --from-literal=apiKey="$EXTERNAL_LLM_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade "$AGENT_RELEASE" "$AGENT_CHART" \
  --version "$AGENT_CHART_VERSION" \
  -n "$AGENT_NAMESPACE" \
  --reuse-values \
  --set llm.mode=external \
  --set-string llm.external.baseUrl="$EXTERNAL_LLM_BASE_URL" \
  --set-string llm.external.model="$EXTERNAL_LLM_MODEL" \
  --set llm.external.existingSecret=afoa-inference-client \
  --set llm.external.apiKeySecretKey=apiKey \
  --wait \
  --timeout 12m

unset EXTERNAL_LLM_API_KEY
```

This changes the configured provider and restarts affected agent pods. Switching from bundled `llm.mode=vllm` also removes that release's bundled inference workload; verify the new endpoint first. The separate inference release and enabled agent modules remain independently managed. Rotating an existing Secret's key also requires restarting the consumers to reload their environment; updating only a Secret does not automatically restart pods.

</details>

<details>
<summary>Check startup and cross-cluster connectivity</summary>

Inspect inference startup in `k8s-user`:

```bash
module load kubernetes/k8s-user
kubectl -n afoa-inference get pods,pvc,service,ingress
kubectl -n afoa-inference describe pod afoa-inference-0
kubectl -n afoa-inference get events --sort-by=.lastTimestamp
kubectl -n afoa-inference logs afoa-inference-0 -c vllm --tail=100
```

`Pending` with insufficient resources indicates a scheduling problem; an unbound PVC indicates a storage problem. Downloads, model loading and first-start kernel compilation are expected. Resources remain available after a Helm timeout so you can inspect progress before retrying.

Switch back to the admin cluster for the connection check:

```bash
module load kubernetes/k8s-admin
```

After installing or switching, verify authenticated model discovery and a short completion from the actual agent pod. This uses the key already mounted into the pod without printing it:

```bash
kubectl -n "${AGENT_NAMESPACE:?Set the existing agent namespace}" exec -i deployment/openclaw -c gateway -- node --input-type=module - <<'JS'
const base = process.env.OPENCLAW_VLLM_BASE_URL.replace(/\/$/, '');
const headers = {
  Authorization: `Bearer ${process.env.VLLM_API_KEY}`,
  'Content-Type': 'application/json',
};
for (const [path, options] of [
  ['/models', {}],
  ['/chat/completions', {method: 'POST', body: JSON.stringify({
    model: 'nemotron-super-120b',
    messages: [{role: 'user', content: 'Reply with ready.'}],
    max_tokens: 32,
  })}],
]) {
  const response = await fetch(`${base}${path}`, {
    ...options, headers, signal: AbortSignal.timeout(120000),
  });
  console.log(`${path}: HTTP ${response.status}`);
  if (!response.ok) process.exit(1);
}
JS
```

Use your configured served model name in the completion check if you changed the default. HTTP 200 for both requests establishes DNS, routing, TLS trust, authentication, and basic inference from the admin cluster. Then ask a short question through the agent UI to verify the full agent path. TLS errors require correcting certificate trust, timeouts require checking routing or server readiness, and 401 responses indicate mismatched keys.

</details>
