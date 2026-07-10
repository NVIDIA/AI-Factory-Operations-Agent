#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

set -euo pipefail

CONTEXT=${CONTEXT:-kind-mosaic-hitl}
NAMESPACE=${NAMESPACE:-mosaic-hitl}
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
k() { kubectl --context "$CONTEXT" -n "$NAMESPACE" "$@"; }

if ! k get secret mosaic-hitl-ssh >/dev/null 2>&1 || ! k get secret mosaic-hitl-ssh-target >/dev/null 2>&1; then
  k delete pod mosaic-hitl-node-a mosaic-hitl-node-b --ignore-not-found
  ssh-keygen -q -t ed25519 -N "" -f "$TMP/client"
  ssh-keygen -q -t ed25519 -N "" -f "$TMP/host"
  cp "$TMP/client.pub" "$TMP/authorized_keys"
  {
    printf 'mosaic-hitl-node-a '
    cat "$TMP/host.pub"
    printf 'mosaic-hitl-node-b '
    cat "$TMP/host.pub"
  } > "$TMP/knownHosts"
  k create secret generic mosaic-hitl-ssh --from-file=privateKey="$TMP/client" --from-file=knownHosts="$TMP/knownHosts" --dry-run=client -o yaml | k apply -f -
  k create secret generic mosaic-hitl-ssh-target --from-file=host="$TMP/host" --from-file=host.pub="$TMP/host.pub" --from-file=authorized_keys="$TMP/authorized_keys" --dry-run=client -o yaml | k apply -f -
fi

k delete pod mosaic-hitl-node-a mosaic-hitl-node-b --ignore-not-found --wait=true
k apply -f - <<'EOF'
apiVersion: v1
kind: Pod
metadata:
  name: mosaic-hitl-node-a
  labels:
    app: mosaic-hitl-node-a
spec:
  automountServiceAccountToken: false
  containers:
    - name: sshd
      image: alpine:3.22
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
          printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' 'UsePAM no' 'AllowUsers tester' >> /etc/ssh/sshd_config
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
        secretName: mosaic-hitl-ssh-target
        defaultMode: 0400
---
apiVersion: v1
kind: Service
metadata:
  name: mosaic-hitl-node-a
spec:
  selector:
    app: mosaic-hitl-node-a
  ports:
    - port: 22
      targetPort: 22
---
apiVersion: v1
kind: Pod
metadata:
  name: mosaic-hitl-node-b
  labels:
    app: mosaic-hitl-node-b
spec:
  automountServiceAccountToken: false
  containers:
    - name: sshd
      image: alpine:3.22
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
          printf '%s\n' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin no' 'UsePAM no' 'AllowUsers tester' >> /etc/ssh/sshd_config
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
        secretName: mosaic-hitl-ssh-target
        defaultMode: 0400
---
apiVersion: v1
kind: Service
metadata:
  name: mosaic-hitl-node-b
spec:
  selector:
    app: mosaic-hitl-node-b
  ports:
    - port: 22
      targetPort: 22
EOF

k wait --for=condition=Ready pod/mosaic-hitl-node-a pod/mosaic-hitl-node-b --timeout=180s
