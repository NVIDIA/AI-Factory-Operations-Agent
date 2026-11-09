#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }

kind_gateway() {
  docker network inspect kind --format '{{json .IPAM.Config}}' | uv run --no-project python -c '
import ipaddress, json, sys
print(next((entry["Gateway"] for entry in json.load(sys.stdin)
            if entry.get("Gateway") and ipaddress.ip_address(entry["Gateway"]).version == 4), ""))'
}

install_service() {
  local chart_dir=$1 service_dir=$2 config_dir=$3 gateway=$4 image=$5 container version token
  [[ ! -e "$config_dir/server.env" ]] || fail "An MCP service is already configured at $config_dir; use the existing-service instructions."
  install -d -m 0755 "$service_dir/vendor"
  install -d -m 0700 "$config_dir" /var/lib/bcm-mcp/notes
  docker pull "$image"
  version=$(docker run --rm --read-only --network none --entrypoint /opt/venv/bin/python "$image" \
    -c 'import importlib.metadata; print(importlib.metadata.version("bcm-mcp-tools"))')
  container=$(docker create "$image")
  if ! docker cp "$container:/opt/venv/lib/python3.12/site-packages/bcm_mcp_tools" "$service_dir/vendor/" || \
     ! docker cp "$container:/opt/venv/lib/python3.12/site-packages/bcm_mcp_tools-$version.dist-info" "$service_dir/vendor/"; then
    docker rm "$container" >/dev/null
    fail 'Could not extract the BCM package from the chart image.'
  fi
  docker rm "$container" >/dev/null
  uv venv --python 3.12 "$service_dir/venv"
  uv pip install --python "$service_dir/venv/bin/python" \
    'mcp[cli]>=1,<2' 'uvicorn>=0.30' 'httpx>=0.27' 'scikit-learn>=1.3' 'cryptography>=41'
  install -m 0644 "$chart_dir/files/bcm-mcp-ssh-server.py" "$service_dir/"
  openssl req -x509 -newkey rsa:3072 -nodes -days 365 \
    -keyout "$config_dir/server.key" -out "$config_dir/server.crt" \
    -subj /CN=afoa-bcm-mcp -addext "subjectAltName=IP:$gateway"
  token=$(openssl rand -hex 32)
  printf '%s' "$token" > "$config_dir/token"
  cat > "$config_dir/server.env" <<EOF
MOSAIC_BCM_EXECUTION_MODE=local
MOSAIC_BCM_ADAPTER_HOST=$gateway
MOSAIC_BCM_ADAPTER_PORT=3002
MOSAIC_BCM_PUBLIC_URL=https://$gateway:3002
MOSAIC_BCM_TLS_CERT=$config_dir/server.crt
MOSAIC_BCM_TLS_KEY=$config_dir/server.key
MOSAIC_BCM_MCP_TOKEN=$token
MOSAIC_BCM_CMSH_ENABLED=true
MOSAIC_BCM_CMSH_ADMIN_ENABLED=false
MOSAIC_BCM_REDFISH_ENABLED=false
MOSAIC_BCM_HARDWARE_COMPAT_ENABLED=false
MCP_NOTES_DIR=/var/lib/bcm-mcp/notes
EOF
  install -m 0644 "$chart_dir/files/bcm-head.service" /etc/systemd/system/afoa-bcm-mcp.service
  systemctl daemon-reload
  systemctl enable --now afoa-bcm-mcp.service
}

write_values() {
  local gateway=$1 llm_url=$2 model=$3
  # JSON is accepted as a Helm values file and preserves literal user input.
  uv run --no-project python - "$gateway" "$llm_url" "$model" <<'PY'
import json
import sys

gateway, url, model = sys.argv[1:]
print(json.dumps({
    "global": {"imagePullSecrets": [{"name": "nvcr-image-pull-secret"}]},
    "llm": {"mode": "external", "external": {
        "baseUrl": url, "model": model, "existingSecret": "mosaic-external-llm"}},
    "modules": {name: {"enabled": name in {"ui", "execution", "kubernetes", "bcm", "webSearch"}}
                for name in ["ui", "execution", "kubernetes", "bcm", "slurm", "observability",
                             "grafana", "research", "diagnostics", "terminal", "edit", "clusters", "webSearch"]},
    "bcmMcp": {"enabled": False, "mode": "external", "mcpUrl": f"https://{gateway}:3002/mcp",
               "authTokenCreate": False, "authTokenSecretName": "bcm-external-mcp-auth",
               "authTokenSecretKey": "token", "caCertificateSecret": "bcm-mcp-ca",
               "headHost": "", "hostSshKeySecretName": ""},
}))
PY
}

main() (
  [[ $(id -u) == 0 ]] || fail 'Run this installer as root on the BCM head node.'
  local tool chart_dir config_dir=/etc/afoa-bcm work image gateway clusters network_id
  local cluster=${KIND_CLUSTER_NAME:-mosaic} namespace=${MOSAIC_NAMESPACE:-aifoa}
  chart_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
  for tool in docker kind helm kubectl uv openssl systemctl ss cmsh; do
    command -v "$tool" >/dev/null || fail "Install $tool before running this script."
  done
  [[ ! -e "$config_dir/server.env" ]] || fail "An MCP service already exists at $config_dir; follow the upgrade instructions instead."
  [[ ! -e "$config_dir/kubeconfig" ]] || fail "A kubeconfig already exists at $config_dir/kubeconfig; inspect the previous installation first."
  [[ -z $(ss -H -ltn 'sport = :3002') ]] || fail 'TCP port 3002 is already in use.'
  docker info >/dev/null
  cmsh -c 'device; list' >/dev/null
  clusters=$(kind get clusters)
  if printf '%s\n' "$clusters" | grep -Fxq -- "$cluster"; then
    fail "Kind cluster $cluster already exists; choose another KIND_CLUSTER_NAME or use the upgrade guide."
  fi
  if systemctl cat afoa-bcm-mcp.service >/dev/null 2>&1; then
    fail 'An afoa-bcm-mcp systemd unit already exists; use the upgrade instructions instead.'
  fi
  EXTERNAL_LLM_BASE_URL=${EXTERNAL_LLM_BASE_URL:-}
  EXTERNAL_LLM_MODEL=${EXTERNAL_LLM_MODEL:-}
  NGC_API_KEY=${NGC_API_KEY:-}
  EXTERNAL_LLM_API_KEY=${EXTERNAL_LLM_API_KEY:-}
  [[ -n $EXTERNAL_LLM_BASE_URL ]] || read -rp 'Inference API base URL: ' EXTERNAL_LLM_BASE_URL
  [[ -n $EXTERNAL_LLM_MODEL ]] || read -rp 'Inference model: ' EXTERNAL_LLM_MODEL
  [[ -n $NGC_API_KEY ]] || { read -rsp 'NGC API key: ' NGC_API_KEY; printf '\n'; }
  [[ -n $EXTERNAL_LLM_API_KEY ]] || { read -rsp 'Inference API key: ' EXTERNAL_LLM_API_KEY; printf '\n'; }
  [[ -n $EXTERNAL_LLM_BASE_URL && -n $EXTERNAL_LLM_MODEL && -n $NGC_API_KEY && -n $EXTERNAL_LLM_API_KEY ]] || fail 'All four inputs are required.'
  work=$(mktemp -d)
  trap 'rm -rf -- "$work"' EXIT
  export DOCKER_CONFIG="$work/docker" HELM_REGISTRY_CONFIG="$work/helm-registry.json"
  install -d -m 0700 "$DOCKER_CONFIG" "$config_dir"
  printf '%s' "$NGC_API_KEY" | docker login nvcr.io --username \$oauthtoken --password-stdin
  printf '%s' "$NGC_API_KEY" | helm registry login nvcr.io --username \$oauthtoken --password-stdin
  unset NGC_API_KEY
  helm dependency build "$chart_dir"
  image=$(uv run --no-project --with pyyaml python - "$chart_dir/values.yaml" <<'PY'
import sys
import yaml

image = yaml.safe_load(open(sys.argv[1]))["bcmMcp"]["image"]
print(f'{image["repository"]}:{image["tag"]}')
PY
  )
  export KUBECONFIG="$config_dir/kubeconfig"
  kind create cluster --name "$cluster" --wait 120s
  gateway=$(kind_gateway)
  [[ -n $gateway ]] || fail 'The Kind Docker network has no IPv4 gateway address.'
  install_service "$chart_dir" /opt/afoa-bcm "$config_dir" "$gateway" "$image"
  if systemctl is-active --quiet shorewall; then
    network_id=$(docker network inspect kind --format '{{.Id}}')
    printf 'Shorewall is active. Configure its Docker integration for bridge br-%s, allowing TCP 3002 to the host.\n' "${network_id:0:12}"
    printf 'Follow the Shorewall section in docs/bcm.md; this installer does not restart Docker or change the firewall.\n'
    read -rp 'Press Enter after the firewall is configured: '
  fi
  write_values "$gateway" "$EXTERNAL_LLM_BASE_URL" "$EXTERNAL_LLM_MODEL" > "$config_dir/values.json"
  printf '%s' "$EXTERNAL_LLM_API_KEY" > "$work/apiKey"
  unset EXTERNAL_LLM_API_KEY
  kubectl --context "kind-$cluster" create namespace "$namespace"
  kubectl --context "kind-$cluster" -n "$namespace" create secret generic nvcr-image-pull-secret \
    --type=kubernetes.io/dockerconfigjson --from-file=".dockerconfigjson=$DOCKER_CONFIG/config.json"
  kubectl --context "kind-$cluster" -n "$namespace" create secret generic mosaic-external-llm --from-file="apiKey=$work/apiKey"
  kubectl --context "kind-$cluster" -n "$namespace" create secret generic bcm-external-mcp-auth --from-file="token=$config_dir/token"
  kubectl --context "kind-$cluster" -n "$namespace" create secret generic bcm-mcp-ca --from-file="ca.crt=$config_dir/server.crt"
  # Check pod-to-service reachability before installing the application.
  cat > "$work/check.yaml" <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: bcm-mcp-connectivity
spec:
  restartPolicy: Never
  containers:
    - name: curl
      image: curlimages/curl:8.15.0
      command: [sh, -ec]
      args:
        - >-
          curl --fail --silent --show-error --retry 10 --retry-connrefused --retry-delay 1
          --max-time 15 --cacert /ca/ca.crt
          -H "Authorization: Bearer \$(cat /auth/token)"
          -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream'
          --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
          -o /dev/null https://$gateway:3002/mcp
      volumeMounts:
        - {name: ca, mountPath: /ca, readOnly: true}
        - {name: auth, mountPath: /auth, readOnly: true}
  volumes:
    - name: ca
      secret: {secretName: bcm-mcp-ca}
    - name: auth
      secret: {secretName: bcm-external-mcp-auth}
EOF
  kubectl --context "kind-$cluster" -n "$namespace" create -f "$work/check.yaml"
  if ! kubectl --context "kind-$cluster" -n "$namespace" wait pod/bcm-mcp-connectivity \
      --for=jsonpath='{.status.phase}'=Succeeded --timeout=180s; then
    kubectl --context "kind-$cluster" -n "$namespace" logs bcm-mcp-connectivity >&2 || true
    fail "The Kind pod cannot reach https://$gateway:3002/mcp. Check the service and head-node firewall; installation state is retained."
  fi
  kubectl --context "kind-$cluster" -n "$namespace" delete pod bcm-mcp-connectivity
  helm install aifoa "$chart_dir" --kube-context "kind-$cluster" -n "$namespace" \
    -f "$config_dir/values.json" --atomic --wait --timeout 12m
  printf 'Installed AFOA with HTTPS BCM MCP at https://%s:3002/mcp.\nKubeconfig: %s\n' "$gateway" "$KUBECONFIG"
)

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
