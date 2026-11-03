# Installation builder

Select your inference path and modules to generate an installation command. Complete [namespace and registry access setup](installation.md#1-create-the-namespace-and-registry-access) and create the indicated Secrets first. For an existing installation, follow the [upgrade instructions](installation.md#upgrade-an-existing-installation) to preserve its site configuration.

CPU, RAM, GPUs and disk update automatically with your selections. Values come from this documentation version’s rendered Helm manifests. Different chart versions or site overrides can change the requirements.

The inference selector defaults to [Qwen3.8 Flash-Next on one B200](installation.md#on-prem-inference), with host RAM offload and reasoning enabled. The Helm charts use the same model by default. Existing Nemotron and external options remain available.

Select Base Command Manager to connect to a head-node MCP server over authenticated HTTPS by default. First complete the [head-node service setup](installation.md#use-a-head-node-mcp-server), then enter its HTTPS endpoint and token Secret. Enable **Use SSH adapter instead (experimental)** to reveal the alternative SSH connection settings. Both paths are documented in the [Base Command Manager installation section](installation.md#base-command-manager).

For a head node without Kubernetes, use the [combined Base Command Manager and Kind installer](bcm.md#install-with-one-script) to set up the service, cluster, credentials, and AFOA together.

The optional **Read-only Redfish** checkbox appears inside the Base Command Manager module block. See the [Redfish installation guide](installation.md#read-only-redfish) for BMC credential resolution and TLS verification settings.

For a checksum-verified mirrored or source-built sandbox backend package, configure the advanced values described under [OpenShell dependency](installation.md#openshell-dependency).

```{raw} html
<div id="install-command-builder"><noscript>Enable JavaScript to use the builder, or follow the <a href="installation.html">installation guide</a>.</noscript></div>
```
