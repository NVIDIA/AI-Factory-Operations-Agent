#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
KIND=${KIND_BIN:-kind}
KUBECTL=${KUBECTL_BIN:-kubectl}
HELM=${HELM_BIN:-helm}
DOCKER=${DOCKER_BIN:-docker}
RUN_ID=${RUN_ID:-$$}
LOCAL_CLUSTER=${LOCAL_CLUSTER:-mosaic-kubernetes-local-e2e-$RUN_ID}
EXTERNAL_CLUSTER=${EXTERNAL_CLUSTER:-mosaic-kubernetes-external-e2e-$RUN_ID}
NAMESPACE=${NAMESPACE:-mosaic-kubernetes-e2e}
TMP=$(mktemp -d)
LOCAL_CONFIG=$TMP/local-admin
EXTERNAL_CONFIG=$TMP/external-admin

cleanup() {
  "$KIND" delete cluster --name "$LOCAL_CLUSTER" >/dev/null 2>&1 || true
  "$KIND" delete cluster --name "$EXTERNAL_CLUSTER" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

local_kubectl() { KUBECONFIG=$LOCAL_CONFIG "$KUBECTL" "$@"; }
external_kubectl() { KUBECONFIG=$EXTERNAL_CONFIG "$KUBECTL" "$@"; }

"$KIND" create cluster --name "$LOCAL_CLUSTER" --kubeconfig "$LOCAL_CONFIG" --wait 120s
"$KIND" create cluster --name "$EXTERNAL_CLUSTER" --kubeconfig "$EXTERNAL_CONFIG" --wait 120s
if "$DOCKER" image inspect ghcr.io/openclaw/openclaw:2026.6.10 >/dev/null 2>&1; then
  "$DOCKER" save ghcr.io/openclaw/openclaw:2026.6.10 -o "$TMP/openclaw.tar"
  case $("$DOCKER" exec "$LOCAL_CLUSTER-control-plane" uname -m) in
    x86_64) platform=linux/amd64 ;;
    aarch64|arm64) platform=linux/arm64 ;;
    *) echo "unsupported Kind architecture" >&2; exit 1 ;;
  esac
  "$DOCKER" exec -i "$LOCAL_CLUSTER-control-plane" ctr --namespace=k8s.io images import --platform "$platform" - < "$TMP/openclaw.tar"
fi

for target in local external; do
  if [[ $target == local ]]; then
    k=local_kubectl
    marker=local-cluster-marker
  else
    k=external_kubectl
    marker=external-cluster-marker
  fi
  "$k" create namespace "$NAMESPACE"
  "$HELM" template "$target" "$ROOT" --namespace "$NAMESPACE" --show-only templates/rbac.yaml | "$k" apply -n "$NAMESPACE" -f -
  "$k" -n kube-system create configmap "$marker" --from-literal=cluster="$target"
  "$k" run e2e-log-source --image=busybox:1.37 --restart=Never -- sh -c 'echo kubernetes-plugin-e2e; sleep 300'
  "$k" wait --for=condition=Ready pod/e2e-log-source --timeout=120s
done

local_token=$(local_kubectl -n "$NAMESPACE" create token openclaw --duration=1h)
external_token=$(external_kubectl -n "$NAMESPACE" create token openclaw --duration=1h)
local_ca=$(local_kubectl -n "$NAMESPACE" get configmap kube-root-ca.crt -o go-template='{{index .data "ca.crt"}}' | base64 | tr -d '\n')
external_ca=$(external_kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
external_ip=$("$DOCKER" inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$EXTERNAL_CLUSTER-control-plane")

cat > "$TMP/local-config" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: local
    cluster:
      certificate-authority-data: $local_ca
      server: https://kubernetes.default.svc
users:
  - name: openclaw
    user:
      token: $local_token
contexts:
  - name: local
    context:
      cluster: local
      user: openclaw
current-context: local
EOF

cat > "$TMP/external-config" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: external
    cluster:
      certificate-authority-data: $external_ca
      server: https://$external_ip:6443
users:
  - name: openclaw
    user:
      token: $external_token
contexts:
  - name: external
    context:
      cluster: external
      user: openclaw
current-context: external
EOF

local_kubectl -n "$NAMESPACE" create secret generic local-kubeconfig --from-file=config="$TMP/local-config"
local_kubectl -n "$NAMESPACE" create secret generic external-kubeconfig --from-file=config="$TMP/external-config"
local_kubectl -n "$NAMESPACE" create configmap kubernetes-plugin-e2e \
  --from-file=policy.ts="$ROOT/files/openclaw-seed/extensions/kubernetes/policy.ts" \
  --from-file=runner.ts="$ROOT/files/openclaw-seed/extensions/kubernetes/runner.ts" \
  --from-file=e2e.ts="$ROOT/tests/kubernetes-kind-client-e2e.ts"

local_kubectl -n "$NAMESPACE" apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: kubernetes-plugin-e2e
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
  initContainers:
    - name: kubectl
      image: ghcr.io/openclaw/openclaw:2026.6.10
      command:
        - sh
        - -c
        - |
          set -eu
          curl -fsSL --retry 5 --retry-all-errors -o /tools/kubectl \
            https://dl.k8s.io/release/v1.34.1/bin/linux/amd64/kubectl
          echo '7721f265e18709862655affba5343e85e1980639395d5754473dafaadcaa69e3  /tools/kubectl' | sha256sum -c -
          chmod 0555 /tools/kubectl
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
      volumeMounts:
        - name: tools
          mountPath: /tools
  containers:
    - name: test
      image: ghcr.io/openclaw/openclaw:2026.6.10
      command: ["node", "--experimental-strip-types", "/test/e2e.ts"]
      securityContext:
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
        readOnlyRootFilesystem: true
      volumeMounts:
        - name: tools
          mountPath: /tools
          readOnly: true
        - name: test
          mountPath: /test
          readOnly: true
        - name: local
          mountPath: /configs/local
          readOnly: true
        - name: external
          mountPath: /configs/external
          readOnly: true
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: tools
      emptyDir: {}
    - name: test
      configMap:
        name: kubernetes-plugin-e2e
    - name: local
      secret:
        secretName: local-kubeconfig
    - name: external
      secret:
        secretName: external-kubeconfig
    - name: tmp
      emptyDir: {}
EOF

if ! local_kubectl -n "$NAMESPACE" wait --for=jsonpath='{.status.phase}'=Succeeded pod/kubernetes-plugin-e2e --timeout=300s; then
  local_kubectl -n "$NAMESPACE" describe pod kubernetes-plugin-e2e
  local_kubectl -n "$NAMESPACE" logs kubernetes-plugin-e2e --all-containers=true
  exit 1
fi
local_kubectl -n "$NAMESPACE" logs kubernetes-plugin-e2e | grep -Fx kubernetes-kind-client-e2e-passed

local_kubectl -n "$NAMESPACE" apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: missing-external-kubeconfig
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  containers:
    - name: test
      image: busybox:1.37
      command: ["true"]
      volumeMounts:
        - name: missing
          mountPath: /config
  volumes:
    - name: missing
      secret:
        secretName: missing-external-kubeconfig
EOF

for _ in {1..30}; do
  if local_kubectl -n "$NAMESPACE" describe pod missing-external-kubeconfig | grep -q 'secret "missing-external-kubeconfig" not found'; then
    echo missing-external-kubeconfig-readiness-failure-passed
    exit 0
  fi
  sleep 2
done
local_kubectl -n "$NAMESPACE" describe pod missing-external-kubeconfig
exit 1
