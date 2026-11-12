# Base Command Manager installation without Kubernetes

Run one setup script on the Base Command Manager head node to create a Kind
cluster, install the head-node MCP service, and connect AFOA over authenticated
HTTPS. The MCP service executes commands locally; AFOA holds a bearer token and
trusts the generated server certificate. It needs no head-node SSH key.

Kind remains independent of Base Command Manager's `cm-kubernetes-setup`
inventory. For an existing Kubernetes cluster, install the service and configure
AFOA using the [Base Command Manager module instructions](installation.md#use-a-head-node-mcp-server).

## Prerequisites

Run as `root` on a Linux head node with Docker, Kind, Helm 3, `kubectl`,
[uv](https://docs.astral.sh/uv/getting-started/installation/), OpenSSL,
`ss`, and systemd installed. CMSH must work locally:

```bash
cmsh -c 'device; list'
```

Obtain access to the `afoa-release` NGC team and a personal API key with the
Private Registry service, as described in the
[registry setup](installation.md#1-create-the-namespace-and-registry-access).
Have an OpenAI-compatible inference API base URL, model name, and API key ready.
The installer prompts for these four inputs; API keys are entered without echo.
You can also supply `EXTERNAL_LLM_BASE_URL`, `EXTERNAL_LLM_MODEL`, `NGC_API_KEY`,
and `EXTERNAL_LLM_API_KEY` through the environment.

Use a fresh Kind cluster name and no existing `/etc/afoa-bcm/server.env` service.
The defaults are cluster `mosaic`, namespace `aifoa`, and MCP port `3002`.
Set `KIND_CLUSTER_NAME` or `MOSAIC_NAMESPACE` to choose different names.
Keep those variables set in the shell used for the commands below. Port
`3002` must be unused. Existing installations use the
[upgrade workflow](installation.md#upgrade-an-existing-installation).

## Install with one script

From the repository checkout, run:

```bash
bash helm/mosaic-stack/files/setup-bcm-kind.sh
```

The [installer](../helm/mosaic-stack/files/setup-bcm-kind.sh) deploys the chart
from the same source tree. It:

1. Authenticates to NGC and prepares the chart's pinned dependencies.
2. Creates Kind with a dedicated kubeconfig at `/etc/afoa-bcm/kubeconfig`.
3. Extracts the Base Command Manager package from the chart's pinned image and installs the same
   extended server used by the [module instructions](installation.md#use-a-head-node-mcp-server).
4. Generates a bearer token and a self-signed certificate for the Kind Docker
   gateway address, and starts `afoa-bcm-mcp.service` on that interface.
5. Creates the registry, inference, MCP token, and CA Secrets in Kubernetes.
6. Checks that a pod can reach the authenticated MCP endpoint with TLS
   verification, then installs AFOA with local Kubernetes and read-only Base Command Manager access.

The certificate expires after one year. Replace it and update the `bcm-mcp-ca`
Secret when rotating certificates. Tokens and service configuration stay under
`/etc/afoa-bcm`; API keys are removed from the installer's temporary files on exit.
The generated Helm values are saved at `/etc/afoa-bcm/values.json` without tokens
or API keys. The default web-search module needs HTTPS egress to DuckDuckGo;
other optional modules can be enabled using the main installation guide.

If Shorewall is active, the script pauses after printing the Kind bridge name.
Complete the firewall procedure below in another shell, then press Enter to
continue. The script does not rewrite host firewall configuration or restart
Docker. If a later step fails, it preserves the cluster and service for diagnosis;
it does not delete workloads or overwrite an existing installation on rerun.

## Recover a failed installation

Inspect the retained state first. To discard a failed installation and retry,
confirm that its Kind cluster contains no workloads you need to keep. Use the
same `KIND_CLUSTER_NAME` as the failed run, then remove only its cluster and
installer-owned service state:

```bash
kind delete cluster --name "${KIND_CLUSTER_NAME:-mosaic}"
systemctl disable --now afoa-bcm-mcp.service
systemctl reset-failed afoa-bcm-mcp.service
rm -f /etc/systemd/system/afoa-bcm-mcp.service
systemctl daemon-reload
rm -rf /opt/afoa-bcm /etc/afoa-bcm
```

Skip service commands if the failure occurred before the unit was installed.
This deletes the retained kubeconfig, generated certificates, token, and values.
Rerun the installer after correcting the original failure.

## Validate Base Command Manager access

Confirm that the Kind node and AI Factory Operations Agent workloads are ready, then issue a real
read-only Base Command Manager request through HTTPS. The first CMSH request
creates or updates `aichatbotuser`:

```bash
export KUBECONFIG=/etc/afoa-bcm/kubeconfig
kubectl get nodes
kubectl -n "${MOSAIC_NAMESPACE:-aifoa}" get pods

MANAGER_TEST_PROMPT='/cluster-management Use Base Command Manager to run "device; list" and summarize the first five devices.'
kubectl -n "${MOSAIC_NAMESPACE:-aifoa}" exec deploy/mosaic-ui -- \
  mosaic --session bcm-install-validation --timeout-ms 180000 \
  "$MANAGER_TEST_PROMPT"

cmsh -c 'user; use aichatbotuser; get profile'

```

The `cmsh` profile command must return `readonly`. No head-node SSH key is
mounted in AFOA. Base Command Manager edit and administration
remain disabled.

The optional `bcmMcp.networkPolicy` applies to every pod in a dedicated AFOA
namespace. It allows all non-head-node egress. Kubernetes combines NetworkPolicy
allow rules, so other egress policies cannot restrict those allowed destinations.
Enforce additional restrictions outside this policy, for example with a firewall
or an enforced proxy.

## Open the UI remotely

Keep this port-forward running on the Base Command Manager head node:

```bash
kubectl -n "${MOSAIC_NAMESPACE:-aifoa}" port-forward svc/mosaic-ui 3210:3000
```

From the operator's workstation, keep an SSH tunnel to the head node running:

```bash
ssh -L 3210:127.0.0.1:3210 root@bcm-head.example.com
```

Retrieve the generated UI credentials on the head node:

```bash
kubectl -n "${MOSAIC_NAMESPACE:-aifoa}" get secret mosaic-ui-auth \
  -o jsonpath='{.data.username}' | base64 --decode; echo
kubectl -n "${MOSAIC_NAMESPACE:-aifoa}" get secret mosaic-ui-auth \
  -o jsonpath='{.data.password}' | base64 --decode; echo
```

Open `http://127.0.0.1:3210` on the workstation. Both forwarding processes
must remain running.

For optional BMC inventory and monitoring, follow the [Read-only Redfish installation](installation.md#read-only-redfish).

## Shorewall configuration

The installer pauses here when Shorewall is active, after creating Kind and
printing its Docker bridge name. Skip this section when Shorewall is inactive. On a Base Command Manager head node
where Shorewall is active, Docker and Shorewall both manage iptables. A
Shorewall start, reload, or restart can otherwise delete Docker's forwarding,
NAT, and port-publishing rules. Keep Shorewall enabled when the Base Command Manager head-node
role requires it. This local workflow does not require exposing the Kind API
outside the head node or adding a temporary Base Command Manager firewall role for it.

This procedure follows [Shorewall's Docker integration](https://shorewall.org/Docker.html)
and was validated with Shorewall 5.2.8. Shorewall 5.2.4 or later is required
for `DOCKER_BRIDGE`. Back up the existing Shorewall files before editing them.
If Base Command Manager or another configuration manager owns these files, store the equivalent
entries in that system so they survive configuration regeneration.

Set these values in `/etc/shorewall/shorewall.conf`, replacing the example
bridge name with the bridge printed by the installer:

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

Permit the Kind workloads to reach the HTTPS MCP service on the head node by adding this entry
to `/etc/shorewall/rules`:

```text
ACCEPT:info    dock    fw    tcp    3002
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
only if Shorewall previously removed its rules. Inspect existing workloads and
arrange a maintenance window before restarting Docker or Shorewall. Then verify that the
Kind node and pod egress survive a Shorewall restart.

Only when Docker rules need restoring, after arranging that maintenance window:

```bash
systemctl restart docker
```

Validate and restart Shorewall:

```bash
shorewall check
systemctl daemon-reload
systemctl restart shorewall
kubectl --kubeconfig /etc/afoa-bcm/kubeconfig wait --for=condition=Ready "node/${KIND_CLUSTER_NAME:-mosaic}-control-plane" --timeout=120s

kubectl --kubeconfig /etc/afoa-bcm/kubeconfig -n "${MOSAIC_NAMESPACE:-aifoa}" run shorewall-egress-check --rm -i --restart=Never \
  --image=curlimages/curl:8.15.0 -- \
  curl --connect-timeout 5 --max-time 15 -sS -o /dev/null \
  -w 'http=%{http_code} tls=%{ssl_verify_result}\n' \
  https://integrate.api.nvidia.com/v1/models

systemctl restart shorewall
kubectl --kubeconfig /etc/afoa-bcm/kubeconfig wait --for=condition=Ready "node/${KIND_CLUSTER_NAME:-mosaic}-control-plane" --timeout=120s
```

An HTTP response such as `401` with `tls=0` confirms network egress and
successful TLS verification. The bridge name belongs to the current Docker
network. Update the Shorewall configuration if the Kind network is recreated.
