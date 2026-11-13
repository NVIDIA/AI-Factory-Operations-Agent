# Installation builder

Select your inference path and modules to generate an installation command. Complete [namespace and registry access setup](installation.md#1-create-the-namespace-and-registry-access) and create the indicated Secrets first. For an existing installation, follow the [upgrade instructions](installation.md#upgrade-an-existing-installation) to preserve its site configuration.

CPU, RAM, GPUs and disk update automatically with your selections. Values come from this documentation version’s rendered Helm manifests. Different chart versions or site overrides can change the requirements.

The inference selector defaults to [Qwen3.8 Flash-Next on one B200](installation.md#on-prem-inference), with host RAM offload and reasoning enabled. The Helm charts use the same model by default. Existing Nemotron and external options remain available.

Base Command Manager defaults to authenticated HTTPS. For a new Kind cluster, use the
[combined installer](bcm.md#install-with-one-script). For an existing cluster,
complete the [head-node service setup](installation.md#use-a-head-node-mcp-server)
and enter its HTTPS endpoint and token Secret. **Use SSH adapter instead
(experimental)** selects the [SSH alternative](installation.md#base-command-manager).

For Hardware diagnostics without a manager, select **Direct BMC credentials (API)** and follow the [Hardware Agent setup](installation.md#hardware-agent). Credentials are submitted through a private API request file.

The optional **Read-only Redfish** checkbox appears inside the Base Command Manager module block. See the [Redfish installation guide](installation.md#read-only-redfish) for BMC credential resolution and TLS verification settings.

For a checksum-verified mirrored or source-built sandbox backend package, configure the advanced values described under [OpenShell dependency](installation.md#openshell-dependency).

To customize the default agent’s name, follow [Agent display name](installation.md#agent-display-name).

```{raw} html
<div id="install-command-builder"><noscript>Enable JavaScript to use the builder, or follow the <a href="installation.html">installation guide</a>.</noscript></div>
```
