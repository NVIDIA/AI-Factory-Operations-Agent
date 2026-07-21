# Kind Installation

This guide installs Mosaic on a disposable local Kind cluster for development and evaluation. It uses an external OpenAI-compatible LLM and enables the local read-only Kubernetes integration. BCM, Slurm, Grafana, Prometheus, Research Agent, and Hardware Agent integrations are disabled because a fresh Kind cluster does not provide those services.

## 1. Prerequisites

Install Docker, Kind, Helm 3, and `kubectl`. Confirm each command is available:

```bash
docker version
kind version
helm version
kubectl version --client
```

Create an NGC personal API key from [NGC Setup > API Keys](https://org.ngc.nvidia.com/setup/api-keys), include the Private Registry service, and ensure the account has pull access to the Mosaic registry.

Obtain an API key, `/v1/chat/completions` base URL, and model name from the same OpenAI-compatible LLM provider.

## 2. Create The Cluster

```bash
kind create cluster --name mosaic
kubectl config use-context kind-mosaic
kubectl cluster-info
```

Kind creates the default `standard` storage class used by Mosaic.

## 3. Configure Credentials And Dependencies

Replace the endpoint and model together when using OpenAI or another provider.

```bash
export EXTERNAL_LLM_BASE_URL='https://inference-api.nvidia.com/v1'
export EXTERNAL_LLM_MODEL='aws/anthropic/bedrock-claude-sonnet-4-6'
MOSAIC_CHART=oci://nvcr.io/0948643769302270/mosaic-stack
read -rsp 'NGC API key: ' NGC_API_KEY; echo
read -rsp 'External LLM API key: ' EXTERNAL_LLM_API_KEY; echo

printf '%s' "$NGC_API_KEY" | helm registry login nvcr.io \
  --username '$oauthtoken' \
  --password-stdin

kubectl create namespace mosaic --dry-run=client -o yaml | kubectl apply -f -
kubectl -n mosaic create secret generic mosaic-external-llm \
  --from-literal=apiKey="$EXTERNAL_LLM_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -
```

## 4. Install Mosaic


```bash
# Remove --devel for the latest stable release, or replace it with --version 0.0.1 to pin that release.
helm upgrade --install mosaic "$MOSAIC_CHART" \
  --devel \
  -n mosaic \
  --create-namespace \
  --set global.registryCredentials.create=true \
  --set-string global.registryCredentials.password="$NGC_API_KEY" \
  --set llm.mode=external \
  --set-string llm.external.baseUrl="$EXTERNAL_LLM_BASE_URL" \
  --set-string llm.external.model="$EXTERNAL_LLM_MODEL" \
  --set llm.external.existingSecret=mosaic-external-llm \
  --set modules.kubernetes.enabled=true \
  --set modules.bcm.enabled=false \
  --set modules.slurm.enabled=false \
  --set modules.observability.enabled=false \
  --set modules.grafana.enabled=false \
  --set modules.research.enabled=false \
  --set modules.diagnostics.enabled=false \
  --set openclaw.pvc.storageClassName=standard \
  --set mosaicUi.auditPvc.storageClassName=standard \
  --reset-values \
  --atomic \
  --wait \
  --timeout 12m

unset NGC_API_KEY EXTERNAL_LLM_API_KEY
```

For upgrades, verification, LLM configuration, module reference, UI access, and headless usage, see the [shared Helm guide](../helm/README.md).

## 5. Delete The Cluster

```bash
kind delete cluster --name mosaic
```
