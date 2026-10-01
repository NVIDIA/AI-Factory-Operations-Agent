# Release installation

Use this guide for a team-scoped early access evaluation on an existing Kubernetes cluster, including a DGX environment. Trial charts are published under the `afoa-release` team. An organization-level chart path will return `401 Unauthorized` for a team-only account.

The commands use `--devel` to select the latest available chart, including prereleases. When you want to pin a deployment, replace `--devel` with `--version <version>` in both the download and installation commands.

## Prerequisites

- Kubernetes with a default StorageClass, `kubectl`, and Helm 3.
- An accepted NGC invitation for the `afoa-release` team and a personal API key with the Private Registry service enabled.
- An OpenAI-compatible inference endpoint, model name, and credentials supplied by your team.
- Cluster administrator access to install the chart's Kubernetes resources and sandbox prerequisite.

## Authenticate to NGC

Create a personal key in [NGC Setup](https://org.ngc.nvidia.com/setup/api-keys). Keep it out of source control and shared logs.

```bash
MOSAIC_CHART=oci://nvcr.io/0948643769302270/afoa-release/mosaic-stack
read -rsp 'NGC API key: ' NGC_API_KEY; echo
printf '%s' "$NGC_API_KEY" | helm registry login nvcr.io \
  --username '$oauthtoken' --password-stdin

helm pull "$MOSAIC_CHART" --devel

kubectl create namespace mosaic --dry-run=client -o yaml | kubectl apply -f -
kubectl -n mosaic create secret docker-registry nvcr-image-pull-secret \
  --docker-server=nvcr.io --docker-username='$oauthtoken' \
  --docker-password="$NGC_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -
unset NGC_API_KEY
```

## Configure inference

Set the base URL and model for your approved provider, then enter its API key. The URL, model, and key must belong to the same provider. The NGC registry key is separate from the inference key.

```bash
read -rp 'OpenAI-compatible base URL: ' EXTERNAL_LLM_BASE_URL
read -rp 'Model name: ' EXTERNAL_LLM_MODEL
read -rsp 'Inference API key: ' EXTERNAL_LLM_API_KEY; echo
kubectl -n mosaic create secret generic mosaic-external-llm \
  --from-literal=apiKey="$EXTERNAL_LLM_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -
unset EXTERNAL_LLM_API_KEY
```

## Install the release

This configuration enables the UI and sandbox execution. Infrastructure integrations remain disabled until you configure their endpoints and credentials.

```bash
helm upgrade --install mosaic "$MOSAIC_CHART" \
  --devel -n mosaic \
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
  --reset-values --atomic --wait --timeout 12m
```

## Verify and open the UI

```bash
kubectl -n mosaic get pods,pvc
kubectl -n mosaic rollout status deployment/mosaic-ui --timeout=5m
kubectl -n mosaic port-forward svc/mosaic-ui 3000:3000
```

Open `http://localhost:3000`. If a pod reports `ImagePullBackOff`, inspect its events with `kubectl -n mosaic describe pod <pod-name>`, and confirm the invitation was accepted by the account that owns your NGC key.

## Build your integration

Expose your system's inventory, health, performance, and logs through an MCP server, using a read-only identity for initial investigation. Select one troubleshooting workflow and validate the evidence returned by the server in your environment. The [Helm guide](../helm/README.md#externally-managed-mcp-servers) describes MCP connection configuration; check the values supported by your pinned chart before enabling additional modules.
