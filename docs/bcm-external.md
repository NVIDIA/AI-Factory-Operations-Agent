# External Base Command Manager MCP without head-node SSH access

External mode connects AFOA to an independently operated HTTPS Base Command Manager MCP server.
The chart does not deploy an SSH adapter or mount the Base Command Manager head-node SSH key.
Existing installations retain their current behavior until external mode is selected.

## Configuration

Use a dedicated AFOA namespace. Create `bcm-mcp-auth` in that namespace with
the token key specified in the values example matching the server's bearer token. If the server uses a private
CA, create `bcm-mcp-ca` with its CA certificate under `ca.crt`.

Use [the external endpoint values example](../helm/mosaic-stack/examples/bcm-external-values.yaml).

Replace both documentation addresses with every address of the head node,
including its VIP and any alternate interfaces reachable from AFOA. Omit
`caCertificateSecret` when the certificate chains to a publicly trusted CA.
Additional LLM CA certificates remain trusted when both integrations use private CAs.

The policy selects every pod in the namespace, including dynamically created
agent sandboxes. It preserves other destinations and permits only the MCP TCP
port at the configured head-node addresses. It also prevents direct SSH from
the Hardware Agent to the head node; Hardware Agent credentials for compute
nodes continue to come from the Base Command Manager lookup API. Administrator SSH access from
outside this namespace is unaffected. If compute-node collection requires a
separate SSH identity, `diagnosticAgent.hostSshKeySecretName` can still reference
that identity; do not reuse the head-node root key.

Kubernetes NetworkPolicies are additive. Another policy granting broader egress
can reopen access. This policy permits other destinations and can broaden
existing egress restrictions, so use a dedicated namespace and inspect its other
policies before deployment. Enforcement requires a compatible CNI; node-local traffic,
host networking, and service address translation can behave differently across
CNIs. Verify access from both the agent runtime and its sandbox before relying
on the restriction. Where the CNI exempts traffic to the hosting node, enforce
the same source/port restriction in the head-node firewall. The chart cannot
configure a firewall on an independently managed head node.

## Server compatibility

The endpoint must implement the Base Command Manager tool contract expected by AFOA. Standard
Base Command Manager diagnostics and CMSH can use the standalone Base Command Manager MCP server. AFOA's optional
Redfish tools, `execute_cmsh_admin`, `slurm_job_evidence`, and Hardware Agent
`/list`, `/lookup/{hostname}`, `/lookup-os/{hostname}` routes additionally require
a compatible server implementation. Merely changing the URL does not add these
features to a stock Base Command Manager MCP release.

For these interfaces, the chart's
`files/bcm-mcp-ssh-server.py` can also run directly on the head node using the
same Base Command Manager Python package version as the chart image (`bcm-mcp-tools` 1.2.9
with MCP Python SDK 1.x for image tag `3c2280ff`). Set these service environment
variables, with secrets held in an operator-managed protected environment file:

Use [the head-node environment example](../helm/mosaic-stack/examples/bcm-head.env.example).

Run the tracked server file from the committed checkout under the head node's
service manager and Base Command Manager Python environment. Local mode requires both a bearer
token and TLS certificate/key. Commands execute locally, so no head-node SSH key
is needed. The process needs the same local privileges used by the existing
adapter, including CMSH readonly-user setup; an MCP token still authorizes
powerful server-side tools.

The environment example also lists the optional Redfish and Hardware Agent
settings. Match the Hardware Agent token to its webhook token in the namespace's
Hardware Agent auth Secret. Match the CMSH admin setting to the explicitly
enabled Base Command Manager edit module; existing approval gates remain in AFOA.
