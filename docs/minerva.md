<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Minerva MCP integration

Connect AI Factory Operations Agent to an existing NVIDIA Minerva deployment for
network telemetry and topology investigations. This integration registers an MCP
connection and preloads schema-discovery and measurement-interpretation guidance.
It does not install Minerva's collection, storage, or UI services.

## Connection prerequisites

Minerva 1.1 publishes a Streamable HTTP endpoint at
`https://<minerva-host>/minerva/mcp`. Its documented authentication flow uses
browser OAuth, including initial Minerva sign-in and a trusted TLS certificate.
See [Connect AI Assistants with NVIDIA Minerva MCP](https://networking-docs.nvidia.com/minerva/1.1.0/connect-ai-assistants-with-nvidia-minerva-mcp).

This chart supports operator-managed server images and external connections with
Secret-backed headers. It does not implement browser OAuth enrollment or refresh.
The existing client-credentials proxy serves a different OAuth flow and does not
replace Minerva's browser authorization. A URL alone is therefore insufficient
for the documented Minerva 1.1 endpoint. Use this integration only with a verified,
operator-provided authentication arrangement supported by your deployment.

## Operator-managed server

Supply an approved server image and its required backend configuration. Set its
actual listening port and MCP path; the chart defaults are port 8080 and `/mcp`.
Configure the server to expose Minerva's guarded, read-only query interface.

```yaml
managedMcpServers:
  servers:
    minerva:
      enabled: true
      image:
        repository: registry.example.com/minerva-mcp
        digest: "<your image digest>"
      # Set port, path, env and secretEnv for your server image.
```

The preset runs as non-root UID 65532 with a read-only root filesystem. Override
`runAsUser` if your image requires a different non-root UID. Keep backend
credentials in Kubernetes Secrets referenced by `secretEnv`.

The five documented discovery/query tools are available in View. Unrecognized
tools require Edit access under the existing tool policy. Configure any required
telemetry and topology backends separately; unavailable topology does not imply
that telemetry is unavailable.

## External connection

Register an existing Minerva MCP endpoint with the name `minerva` to install the
same investigation guidance without deploying a managed server. This example
assumes an operator has verified that the endpoint accepts the supplied header;
it does not establish that the Minerva 1.1 browser endpoint accepts static tokens.

```yaml
externalMcpServers:
  minerva:
    url: https://minerva.example.com/minerva/mcp
    secretHeaders:
      Authorization:
        name: minerva-mcp-auth
        key: authorization
    toolPolicy:
      defaultAccess: edit
      viewTools:
        - list_capabilities
        - get_capability_schema
        - druid_query
        - get_neo4j_schema
        - neo4j_query
```

The Secret contains the complete supported Authorization header. Maintain its
validity using your deployment's credential lifecycle. Do not configure both a
managed server and an external connection named `minerva` at the same time.

## Verify an investigation

Ask which telemetry and topology capabilities Minerva exposes, then request a
bounded fabric investigation. The agent discovers the live schema before querying,
checks measurement coverage and freshness, and reports affected devices and
interfaces with units. Empty or null results alone do not establish a healthy
fabric. Inspect the tool history to confirm that the answer used Minerva evidence.

Minerva's documented MCP interface is read-only and is not tenant-aware. An
authorized connection can access the deployment's data; namespace and cluster
query filters do not enforce per-user isolation. UI embedding is separate from
this MCP connection and depends on the Minerva UI's framing policy and sign-in.
