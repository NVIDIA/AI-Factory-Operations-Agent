# NMC Installation

This guide installs Mosaic on an NVIDIA Mission Control admin cluster. For upgrades, verification, LLM configuration, module reference, UI access, and headless usage, see the [shared Helm guide](../helm/README.md).

Run this flow from the BCM head node after setting `NGC_API_KEY`, `EXTERNAL_LLM_API_KEY`, `EXTERNAL_LLM_BASE_URL`, and `EXTERNAL_LLM_MODEL`. The endpoint, model, and API key must belong to the same OpenAI-compatible provider. For OpenAI, use `https://api.openai.com/v1` and a model available to that account.

Create an NGC personal API key from [NGC Setup > API Keys](https://org.ngc.nvidia.com/setup/api-keys), include the Private Registry service, and ensure the account has pull access to the Mosaic registry. NGC displays a newly generated key only once. Run the command in a login shell where `module load` is available.

The command selects the NMC `k8s-admin` cluster, connects Mosaic to the existing `kube-prometheus-stack` services, enables BCM-backed Slurm, and installs the AgentSandbox CRD and controller from the Mosaic chart.

```bash
set -euo pipefail
module load kubernetes/k8s-admin

: "${NGC_API_KEY:?Set NGC_API_KEY to an NGC API key with Mosaic registry access}"
: "${EXTERNAL_LLM_API_KEY:?Set EXTERNAL_LLM_API_KEY for the selected provider}"
: "${EXTERNAL_LLM_BASE_URL:?Set EXTERNAL_LLM_BASE_URL for the selected provider}"
: "${EXTERNAL_LLM_MODEL:?Set EXTERNAL_LLM_MODEL for the selected provider}"
MOSAIC_NAMESPACE=${MOSAIC_NAMESPACE:-mosaic}
MOSAIC_CHART=oci://nvcr.io/0948643769302270/mosaic-stack
MOSAIC_CHART_VERSION=${MOSAIC_CHART_VERSION:-0.0.1}
BCM_HEAD_HOST=${BCM_HEAD_HOST:-$(hostname -s)}
BCM_SSH_KEY_PATH=${BCM_SSH_KEY_PATH:-/root/.ssh/id_ecdsa}

test -r "$BCM_SSH_KEY_PATH"
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
  --from-file=id_ecdsa="$BCM_SSH_KEY_PATH" \
  --dry-run=client -o yaml | kubectl apply -f -

GRAFANA_USERNAME=$(kubectl -n prometheus get secret kube-prometheus-stack-grafana -o jsonpath='{.data.admin-user}' | base64 -d)
GRAFANA_PASSWORD=$(kubectl -n prometheus get secret kube-prometheus-stack-grafana -o jsonpath='{.data.admin-password}' | base64 -d)
kubectl -n "$MOSAIC_NAMESPACE" create secret generic mosaic-grafana-auth \
  --from-literal=username="$GRAFANA_USERNAME" \
  --from-literal=password="$GRAFANA_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade --install mosaic "$MOSAIC_CHART" \
  --version "$MOSAIC_CHART_VERSION" \
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
  --set-string bcmMcp.headHost="$BCM_HEAD_HOST" \
  --set bcmMcp.hostSshKeySecretName=bcm-host-ssh-key \
  --set modules.slurm.enabled=true \
  --set modules.slurm.backend=auto \
  --reset-values \
  --wait \
  --timeout 12m
```

The command is a complete declaration and can be rerun unchanged. The SSH private key remains in the `bcm-host-ssh-key` Kubernetes Secret and is mounted only into the BCM adapter pod. On the first generic BCM MCP request, the adapter installs its matching remote server version on the BCM head automatically. With both modules enabled, the Slurm skill selects BCM WLM access instead of host-mounted vanilla evidence.

Before following the shared upgrade workflow in a new shell, run `module load kubernetes/k8s-admin` to select the NMC admin cluster.
