#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
KIND=${KIND_BIN:-kind}
KUBECTL=${KUBECTL_BIN:-kubectl}
DOCKER=${DOCKER_BIN:-docker}
RUN_ID=${RUN_ID:-$$}
CLUSTER=${CLUSTER:-mosaic-remote-ssh-e2e-$RUN_ID}
NAMESPACE=${NAMESPACE:-mosaic-remote-ssh-e2e}
TMP=$(mktemp -d)
KUBECONFIG=$TMP/kubeconfig

cleanup() {
  "$KIND" delete cluster --name "$CLUSTER" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

"$KIND" create cluster --name "$CLUSTER" --kubeconfig "$KUBECONFIG" --wait 120s
case $("$DOCKER" exec "$CLUSTER-control-plane" uname -m) in
  x86_64) platform=linux/amd64 ;;
  aarch64|arm64) platform=linux/arm64 ;;
  *) echo "unsupported Kind architecture" >&2; exit 1 ;;
esac
load_image() {
  local source=$1 target=$2 archive=$3
  "$DOCKER" image inspect "$source" >/dev/null 2>&1 || "$DOCKER" pull "$source"
  "$DOCKER" tag "$source" "$target"
  "$DOCKER" save "$target" -o "$archive"
  "$DOCKER" exec -i "$CLUSTER-control-plane" ctr --namespace=k8s.io images import --platform "$platform" - < "$archive"
}
load_image alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce kind.local/alpine:3.22 "$TMP/alpine.tar"
load_image alpine/git@sha256:e043be20669db13cbcfb6190192babee4cf2dca98709bb0c2d08ca2d35a0a06a kind.local/alpine-git:e043be20 "$TMP/alpine-git.tar"
load_image ghcr.io/openclaw/openclaw:2026.6.6@sha256:4826ca6157377e93463786d5c16852e34eede9f4bd4be55e3773cdc509762857 kind.local/openclaw:2026.6.6 "$TMP/openclaw.tar"
k() { KUBECONFIG=$KUBECONFIG "$KUBECTL" "$@"; }
k create namespace "$NAMESPACE"

ssh-keygen -q -t ed25519 -N "" -f "$TMP/client"
ssh-keygen -q -t ed25519 -N "" -f "$TMP/host"
cp "$TMP/client.pub" "$TMP/authorized_keys"
printf 'ssh-target %s\n' "$(cat "$TMP/host.pub")" > "$TMP/known_hosts"

k -n "$NAMESPACE" create secret generic ssh-target-keys \
  --from-file=host="$TMP/host" \
  --from-file=host.pub="$TMP/host.pub" \
  --from-file=authorized_keys="$TMP/authorized_keys"
k -n "$NAMESPACE" create secret generic ssh-client \
  --from-file=id="$TMP/client" \
  --from-file=known_hosts="$TMP/known_hosts"

k -n "$NAMESPACE" apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: ssh-target
  labels:
    app: ssh-target
spec:
  restartPolicy: Never
  containers:
    - name: sshd
      image: kind.local/alpine:3.22
      imagePullPolicy: Never
      command: ["sh", "-c"]
      args:
        - |
          set -eu
          apk add --no-cache openssh-server
          adduser -D tester
          echo 'tester:kind-only' | chpasswd
          install -d -m 0700 -o tester -g tester /home/tester/.ssh
          install -m 0600 -o tester -g tester /keys/authorized_keys /home/tester/.ssh/authorized_keys
          install -m 0600 /keys/host /etc/ssh/ssh_host_ed25519_key
          install -m 0644 /keys/host.pub /etc/ssh/ssh_host_ed25519_key.pub
          printf '%s\n' \
            'PasswordAuthentication no' \
            'KbdInteractiveAuthentication no' \
            'PermitRootLogin no' \
            'UsePAM no' \
            'AllowUsers tester' >> /etc/ssh/sshd_config
          exec /usr/sbin/sshd -D -e
      readinessProbe:
        tcpSocket:
          port: 22
        periodSeconds: 1
      volumeMounts:
        - name: keys
          mountPath: /keys
          readOnly: true
  volumes:
    - name: keys
      secret:
        secretName: ssh-target-keys
        defaultMode: 0400
---
apiVersion: v1
kind: Service
metadata:
  name: ssh-target
spec:
  selector:
    app: ssh-target
  ports:
    - port: 22
      targetPort: 22
EOF
k -n "$NAMESPACE" wait --for=condition=Ready pod/ssh-target --timeout=180s

k -n "$NAMESPACE" create configmap remote-ssh-kind-e2e \
  --from-file=index.ts="$ROOT/files/openclaw-seed/extensions/remote-ssh/index.ts" \
  --from-file=policy.ts="$ROOT/files/openclaw-seed/extensions/remote-ssh/policy.ts" \
  --from-file=runner.ts="$ROOT/files/openclaw-seed/extensions/remote-ssh/runner.ts" \
  --from-file=e2e.ts="$ROOT/tests/remote-ssh-kind-client-e2e.ts"

k -n "$NAMESPACE" apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: remote-ssh-kind-e2e
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
  initContainers:
    - name: install-openssh-client
      image: kind.local/alpine-git:e043be20
      imagePullPolicy: Never
      command: ["sh", "-c"]
      args:
        - |
          set -eu
          root=/tools/openssh
          mkdir -p "$root/lib" "$root/usr/bin" "$root/usr/lib"
          cp /lib/ld-musl-*.so.1 "$root/lib/"
          cp /usr/lib/libcrypto.so.3 /usr/lib/libz.so.1 "$root/usr/lib/"
          cp /usr/bin/ssh "$root/usr/bin/"
          loader=$(basename /lib/ld-musl-*.so.1)
          printf '#!/bin/sh\nexec /tools/openssh/lib/%s --library-path /tools/openssh/usr/lib:/tools/openssh/lib /tools/openssh/usr/bin/ssh "$@"\n' "$loader" > /tools/ssh
          chmod 0555 /tools/ssh
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
      image: kind.local/openclaw:2026.6.6
      imagePullPolicy: Never
      command: ["node", "--experimental-strip-types", "/app/test/e2e.ts"]
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
          mountPath: /app/test
          readOnly: true
        - name: credentials
          mountPath: /credentials
          readOnly: true
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: tools
      emptyDir: {}
    - name: test
      configMap:
        name: remote-ssh-kind-e2e
    - name: credentials
      secret:
        secretName: ssh-client
        defaultMode: 0440
    - name: tmp
      emptyDir: {}
EOF

for _ in $(seq 1 300); do
  phase="$(k -n "$NAMESPACE" get pod remote-ssh-kind-e2e -o jsonpath='{.status.phase}')"
  case "$phase" in
    Succeeded) break ;;
    Failed)
      k -n "$NAMESPACE" describe pod remote-ssh-kind-e2e
      k -n "$NAMESPACE" logs remote-ssh-kind-e2e --all-containers=true
      exit 1
      ;;
  esac
  sleep 1
done
if [[ "${phase:-}" != Succeeded ]]; then
  k -n "$NAMESPACE" describe pod remote-ssh-kind-e2e
  k -n "$NAMESPACE" logs remote-ssh-kind-e2e --all-containers=true
  exit 1
fi
k -n "$NAMESPACE" logs remote-ssh-kind-e2e | grep -Fx remote-ssh-kind-e2e-passed
