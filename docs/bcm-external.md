# Install the Base Command Manager MCP server on the head node

Use this option when AFOA should connect over HTTPS without a head-node SSH key.
The MCP service runs on the head node's existing IP address and listens on a
configured port, such as `3002`. Install the service first, then configure AFOA
using [Use a head-node MCP server](installation.md#use-a-head-node-mcp-server).

## Prerequisites

Run the installation as `root` on the head node. It requires Docker, Helm 3,
[uv](https://docs.astral.sh/uv/getting-started/installation/), and the NGC registry
access configured in the [installation guide](installation.md#1-create-the-namespace-and-registry-access).
The head node must have working CMSH and access to the compute-node and BMC
networks used by your enabled integrations.

Provide a TLS server certificate and private key. The certificate must cover
the hostname used in the MCP URL. Keep its signing CA certificate for AFOA if
it is privately issued. Choose an unused listening port and a head-node address
reachable from the Kubernetes cluster.

## Install the service files and Python environment

The commands below install the server shipped with this chart and the Base
Command Manager package from its pinned container image. Docker creates a
stopped container solely to copy the package; the service runs directly on the
head node. These commands do not modify the image.

```bash
export MOSAIC_CHART='oci://nvcr.io/0948643769302270/afoa-release/mosaic-stack'
export CLUSTER_MANAGER_IMAGE='nvcr.io/0948643769302270/afoa-release/bcm-mcp-tools:3c2280ff'
export CLUSTER_MANAGER_TLS_CERT='/path/to/server.crt'
export CLUSTER_MANAGER_TLS_KEY='/path/to/server.key'
CLUSTER_MANAGER_CHART_DIR=$(mktemp -d)

# Use the same chart version selected for AFOA; replace --devel with --version when pinning.
helm pull "$MOSAIC_CHART" --devel --untar --untardir "$CLUSTER_MANAGER_CHART_DIR"
install -d -m 0755 /opt/afoa-bcm/vendor
install -d -m 0700 /etc/afoa-bcm /var/lib/bcm-mcp/notes

read -rsp 'NGC API key: ' NGC_API_KEY; echo
printf '%s' "$NGC_API_KEY" | docker login nvcr.io --username '$oauthtoken' --password-stdin
unset NGC_API_KEY
docker pull "$CLUSTER_MANAGER_IMAGE"
CLUSTER_MANAGER_CONTAINER=$(docker create "$CLUSTER_MANAGER_IMAGE")
docker cp "$CLUSTER_MANAGER_CONTAINER:/opt/venv/lib/python3.12/site-packages/bcm_mcp_tools" /opt/afoa-bcm/vendor/
docker cp "$CLUSTER_MANAGER_CONTAINER:/opt/venv/lib/python3.12/site-packages/bcm_mcp_tools-1.2.9.dist-info" /opt/afoa-bcm/vendor/
docker rm "$CLUSTER_MANAGER_CONTAINER"

uv venv --python 3.12 /opt/afoa-bcm/venv
uv pip install --python /opt/afoa-bcm/venv/bin/python \
  'mcp[cli]>=1,<2' 'uvicorn>=0.30' 'httpx>=0.27' \
  'scikit-learn>=1.3' 'cryptography>=41'

install -m 0644 "$CLUSTER_MANAGER_CHART_DIR/mosaic-stack/files/bcm-mcp-ssh-server.py" /opt/afoa-bcm/
install -m 0600 "$CLUSTER_MANAGER_CHART_DIR/mosaic-stack/examples/bcm-head.env.example" /etc/afoa-bcm/server.env
install -m 0644 "$CLUSTER_MANAGER_CHART_DIR/mosaic-stack/files/bcm-head.service" /etc/systemd/system/afoa-bcm-mcp.service
install -m 0644 "$CLUSTER_MANAGER_TLS_CERT" /etc/afoa-bcm/server.crt
install -m 0600 "$CLUSTER_MANAGER_TLS_KEY" /etc/afoa-bcm/server.key
```

The pinned image contains `bcm-mcp-tools` 1.2.9 and uses MCP Python SDK 1.x.
Keep the image, package path, and Python dependencies aligned when changing the
server version.

## Configure and start the server

Edit `/etc/afoa-bcm/server.env` using the installed
[environment example](../helm/mosaic-stack/examples/bcm-head.env.example):

- Set the listening IP to the head-node interface reachable from AFOA.
- Set the listening port and public HTTPS URL to the same endpoint.
- Set the certificate and key paths to the files installed above.
- Replace the bearer-token placeholder with a secret generated with `openssl rand -hex 32`.
  Use the same token when creating AFOA's Kubernetes Secret.
- Enable the optional Redfish and Hardware Agent settings only when those modules
  are enabled in AFOA. For Hardware Agent compatibility, match its webhook token
  in the namespace's Hardware Agent auth Secret. Match the admin CMSH setting to
  the Base Command Manager edit module.

Local execution requires both a bearer token and TLS certificate/key. The service
needs local administrator privileges for CMSH readonly-user setup and the optional
administration and hardware integrations. AFOA's existing approval gates remain
in effect for agent-initiated edits.

```bash
systemctl daemon-reload
systemctl enable --now afoa-bcm-mcp.service
systemctl status afoa-bcm-mcp.service --no-pager
ss -ltnp 'sport = :3002'
```

Use your configured port in the last command. The service implements the same
CMSH, diagnostic, Slurm evidence, Redfish, and Hardware Agent interfaces as the
SSH adapter. A stock standalone MCP release must provide those same interfaces
before it can replace this service for all optional integrations.

## Restrict head-node network access

The head-node administrator configures its firewall to permit the MCP TCP port
from the cluster's actual source addresses. Depending on cluster routing, these
can be pod or node addresses. Keep the rule in the system that manages the
head-node firewall, including Base Command Manager-managed Shorewall where used.
The Helm chart does not configure the host firewall or grant network reachability
merely by setting the MCP URL.

For a dedicated AFOA namespace, the
[external endpoint values example](../helm/mosaic-stack/examples/bcm-external-values.yaml)
also enables a Kubernetes NetworkPolicy. Replace its documentation addresses with
every address of the head node, including any VIP and reachable alternate
interfaces, and set the MCP port to match the URL. This policy selects all pods
in the namespace, including dynamically created sandboxes, and permits only the
MCP TCP port at those head-node addresses. Other destinations remain permitted.
Administrator SSH access from outside the namespace is unaffected.

NetworkPolicies are additive: other policies can reopen access, and this policy
can broaden existing egress restrictions for other destinations. Use a dedicated
namespace and inspect its existing policies. Enforcement requires a compatible
CNI. Node-local traffic, host networking, and service address translation can
behave differently across CNIs. If the CNI exempts traffic to the hosting node,
apply the corresponding source/port restriction in the head-node firewall.

Continue with [AFOA's head-node MCP connection configuration](installation.md#use-a-head-node-mcp-server).
