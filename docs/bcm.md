# BCM Installation Without Kubernetes

This guide installs AI Factory Operations Agent on a Base Command Manager
(BCM) head node when BCM does not manage a Kubernetes cluster. It creates a
single-node Kind cluster on the head node and enables read-only BCM access over
SSH. Kind remains independent of BCM's `cm-kubernetes-setup` inventory.

For upgrades, UI access, and module configuration, see the
[shared Helm guide](../helm/README.md).

## 1. Prerequisites

Run this procedure as `root` on the BCM head node. Install Docker, Kind, Helm
3, and `kubectl`, then verify BCM and each dependency:

```bash
docker version
kind version
helm version
kubectl version --client
cmsh -c 'device; list'
```

Create an NGC personal API key from
[NGC Setup > API Keys](https://org.ngc.nvidia.com/setup/api-keys), include the
Private Registry service, and confirm that the account can pull the required
private registry artifacts. Obtain an API key, `/v1/chat/completions` base URL,
and model name from the same OpenAI-compatible LLM provider.

The BCM adapter also requires an SSH private key that can connect to the head
node as `root`. It uses that identity to create or update the dedicated
`aichatbotuser` CMSH account with the `readonly` profile. Do not create that
account manually.

## 2. Create The Kind Cluster

```bash
kind create cluster --name mosaic --wait 120s
kubectl config use-context kind-mosaic
kubectl cluster-info

KIND_NETWORK_ID=$(docker network inspect kind --format '{{.Id}}')
KIND_BRIDGE="br-${KIND_NETWORK_ID:0:12}"
KIND_GATEWAY=$(docker network inspect kind --format '{{(index .IPAM.Config 0).Gateway}}')
printf 'bridge=%s gateway=%s\n' "$KIND_BRIDGE" "$KIND_GATEWAY"
```

Kind provides the `standard` storage class. The Docker network gateway is the
BCM head address reachable from the Kind cluster; `127.0.0.1` inside a pod
would refer to that pod.

## 3. Configure Shorewall

Skip this section when Shorewall is not installed or active. On a BCM head node
where Shorewall is active, Docker and Shorewall both manage iptables. A
Shorewall start, reload, or restart can otherwise delete Docker's forwarding,
NAT, and port-publishing rules. Keep Shorewall enabled when the BCM head-node
role requires it. This local workflow does not require exposing the Kind API
outside the head node or adding a temporary BCM firewall role for it.

This procedure follows [Shorewall's Docker integration](https://shorewall.org/Docker.html)
and was validated with Shorewall 5.2.8. Shorewall 5.2.4 or later is required
for `DOCKER_BRIDGE`. Back up the existing Shorewall files before editing them.
If BCM or another configuration manager owns these files, store the equivalent
entries in that system so they survive configuration regeneration.

Set these values in `/etc/shorewall/shorewall.conf`, replacing the example
bridge name with `$KIND_BRIDGE` from the previous step:

```ini
DOCKER=Yes
DOCKER_BRIDGE=br-0123456789ab
```

Add a Docker zone to `/etc/shorewall/zones`:

```text
dock    ipv4
```

Add the Kind bridge to `/etc/shorewall/interfaces`:

```text
dock    br-0123456789ab    detect    bridge
```

Add these entries before the final catch-all policy in
`/etc/shorewall/policy`:

```text
dock    fw     REJECT    info
dock    all    ACCEPT
```

Permit the BCM adapter to reach only SSH on the head node by adding this entry
to `/etc/shorewall/rules`:

```text
ACCEPT:info    dock    fw    tcp    22
```

On Debian-derived systems, create
`/etc/systemd/system/shorewall.service.d/docker.conf` so service restarts use
`stop` instead of clearing Docker's rules:

```ini
[Service]
ExecStop=
ExecStop=/usr/sbin/shorewall $OPTIONS stop
```

With Shorewall 5.2.8 and Docker 29, restored Docker rules also required
established return traffic to be accepted before Docker's hooks. Add the
following before the final `return 0` in `/etc/shorewall/start`, replacing the
example bridge name:

```bash
KIND_BRIDGE=br-0123456789ab
/sbin/iptables -w -n -L DOCKER-USER >/dev/null 2>&1 || return 0
/sbin/iptables -w -C DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
  /sbin/iptables -w -I DOCKER-USER 1 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
/sbin/iptables -w -C OUTPUT -o "$KIND_BRIDGE" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || \
  /sbin/iptables -w -I OUTPUT 1 -o "$KIND_BRIDGE" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
return 0
```

Check the configuration before changing the running firewall. Restart Docker
once to recreate any rules Shorewall previously removed, then verify that the
Kind node and pod egress survive a Shorewall restart:

```bash
shorewall check
systemctl daemon-reload
systemctl restart docker
systemctl restart shorewall
kubectl wait --for=condition=Ready node/mosaic-control-plane --timeout=120s

kubectl run shorewall-egress-check --rm -i --restart=Never \
  --image=curlimages/curl:8.15.0 -- \
  curl --connect-timeout 5 --max-time 15 -sS -o /dev/null \
  -w 'http=%{http_code} tls=%{ssl_verify_result}\n' \
  https://inference-api.nvidia.com/v1/models

systemctl restart shorewall
kubectl wait --for=condition=Ready node/mosaic-control-plane --timeout=120s
```

An HTTP response such as `401` with `tls=0` confirms network egress and
successful TLS verification. The bridge name belongs to the current Docker
network. Update the Shorewall configuration if the Kind network is recreated.

## 4. Configure Credentials

Set the provider values and select the head node's Kind-network address. The
SSH preflight must return `0`, confirming root access through the same network
path the BCM adapter will use:

```bash
export EXTERNAL_LLM_BASE_URL='https://inference-api.nvidia.com/v1'
export EXTERNAL_LLM_MODEL='aws/anthropic/bedrock-claude-sonnet-4-6'
export BCM_HEAD_HOST="$KIND_GATEWAY"
export BCM_SSH_KEY_PATH='/root/.ssh/id_ecdsa'
export MOSAIC_CHART='oci://nvcr.io/0948643769302270/mosaic-stack'

read -rsp 'NGC API key: ' NGC_API_KEY; echo
read -rsp 'External LLM API key: ' EXTERNAL_LLM_API_KEY; echo

test -r "$BCM_SSH_KEY_PATH"
ssh -i "$BCM_SSH_KEY_PATH" -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new "$BCM_HEAD_HOST" 'id -u'

printf '%s' "$NGC_API_KEY" | helm registry login nvcr.io \
  --username '$oauthtoken' \
  --password-stdin

kubectl create namespace mosaic --dry-run=client -o yaml | kubectl apply -f -
kubectl -n mosaic create secret generic mosaic-external-llm \
  --from-literal=apiKey="$EXTERNAL_LLM_API_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n mosaic create secret generic bcm-host-ssh-key \
  --from-file=id_ecdsa="$BCM_SSH_KEY_PATH" \
  --dry-run=client -o yaml | kubectl apply -f -
```

The private key is stored in the `bcm-host-ssh-key` Kubernetes Secret and
mounted only into the BCM adapter pod.

## 5. Install AI Factory Operations Agent

This installation enables the UI, local Kubernetes inspection, and read-only
BCM inspection. Other cluster integrations remain disabled.

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
  --set modules.ui.enabled=true \
  --set modules.execution.enabled=true \
  --set modules.kubernetes.enabled=true \
  --set modules.bcm.enabled=true \
  --set bcmMcp.enabled=true \
  --set bcmMcp.mode=ssh-adapter \
  --set-string bcmMcp.headHost="$BCM_HEAD_HOST" \
  --set bcmMcp.hostSshKeySecretName=bcm-host-ssh-key \
  --set modules.slurm.enabled=false \
  --set modules.observability.enabled=false \
  --set modules.grafana.enabled=false \
  --set modules.research.enabled=false \
  --set modules.diagnostics.enabled=false \
  --set modules.terminal.enabled=false \
  --set openclaw.pvc.storageClassName=standard \
  --set mosaicUi.auditPvc.storageClassName=standard \
  --reset-values \
  --atomic \
  --wait \
  --timeout 12m

unset NGC_API_KEY EXTERNAL_LLM_API_KEY
```

## 6. Validate BCM Access

Confirm that the Kind node and Mosaic workloads are ready, then issue a real
read-only BCM request. The first request creates or updates `aichatbotuser`:

```bash
kubectl get nodes
kubectl -n mosaic get pods

BCM_TEST_PROMPT='/cluster-management Use BCM to run "device; list" and summarize the first five devices.'
kubectl -n mosaic exec deploy/mosaic-ui -- \
  mosaic --session bcm-install-validation --timeout-ms 180000 \
  "$BCM_TEST_PROMPT"

cmsh -c 'user; use aichatbotuser; get profile'

if systemctl is-active --quiet shorewall; then
  systemctl restart shorewall
  kubectl wait --for=condition=Ready node/mosaic-control-plane --timeout=120s
  kubectl -n mosaic exec deploy/mosaic-ui -- \
    mosaic --session bcm-restart-validation --timeout-ms 180000 \
    "$BCM_TEST_PROMPT"
fi
```

The `cmsh` profile command must return `readonly`. BCM edit and administration
remain disabled.

## 7. Open The UI Remotely

Keep this port-forward running on the BCM head node:

```bash
kubectl -n mosaic port-forward svc/mosaic-ui 3210:3000
```

From the operator's workstation, keep an SSH tunnel to the head node running:

```bash
ssh -L 3210:127.0.0.1:3210 root@bcm-head.example.com
```

Retrieve the generated UI credentials on the head node:

```bash
kubectl -n mosaic get secret mosaic-ui-auth \
  -o jsonpath='{.data.username}' | base64 --decode; echo
kubectl -n mosaic get secret mosaic-ui-auth \
  -o jsonpath='{.data.password}' | base64 --decode; echo
```

Open `http://127.0.0.1:3210` on the workstation. Both forwarding processes
must remain running.
