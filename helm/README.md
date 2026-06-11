# Mosaic Helm Deployment

Mosaic is installed with Helm. The public chart surface includes the Mosaic UI, OpenClaw/NemoClaw execution, read-only Kubernetes inspection, observability/Grafana helpers, and vanilla Slurm log RCA.

## 1. Prepare Values

```bash
cp helm/values-secrets.example.yaml helm/values-secrets.yaml
$EDITOR helm/values-secrets.yaml
```

`helm/values-secrets.yaml` is gitignored. Use it for local deployment secrets such as registry credentials, gated model tokens, and the OpenClaw gateway token.

## 2. Install Or Upgrade

```bash
helm upgrade --install mosaic ./helm/mosaic-stack \
  -n mosaic \
  --create-namespace \
  -f helm/values-secrets.yaml \
  --reset-values \
  --wait \
  --timeout 12m
```

Set image repositories and tags in values for your registry before installing. The defaults are placeholders for source-based development.

## 3. LLM Modes

- `llm.mode=vllm`: deploys chart-managed vLLM. Use `helm/mosaic-stack/profiles/vllm-super-1gpu.yaml` for a small single-GPU profile or `helm/mosaic-stack/profiles/vllm-ultra-16gpu.yaml` for a larger distributed profile.
- `llm.mode=external`: does not deploy vLLM. Set `llm.external.baseUrl`, `llm.external.model`, and optionally `llm.external.existingSecret` plus `llm.external.apiKeySecretKey`.

## 4. Open The UI

```bash
kubectl -n mosaic port-forward svc/mosaic-ui 3000:3000
```

Open `http://localhost:3000`.

## Secrets

The public chart can create the required Kubernetes Secrets from values:

- `registryCredentials.password`: creates the image pull secret when `registryCredentials.create=true`.
- `llm.vllm.secrets.hfToken`: creates the model download token secret when `llm.vllm.secrets.create=true`.
- `openclaw.secrets.gatewayToken`: creates the OpenClaw gateway token when `openclaw.secrets.create=true`.

For production, prefer injecting values from your secret manager or precreating Kubernetes Secrets and referencing them by name.

## Vanilla Slurm RCA

The public Slurm workflow is log based. Mount Slurm accounting exports and job logs into the OpenClaw sandbox at one of the documented paths, such as `/slurm/accounting`, `/slurm/logs`, or `/cm/shared/slurm-logs`. The seeded Slurm skill inspects those files and summarizes concrete job evidence.

## OpenShell Dependency

Packaged chart releases include a pinned OpenShell Helm dependency. Source installs should either vendor that dependency through the release process or install a compatible OpenShell chart before deploying Mosaic.
