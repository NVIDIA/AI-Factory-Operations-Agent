# Installation builder

Select your inference path and modules to generate an installation command. Complete [namespace and registry access setup](installation.md#1-create-the-namespace-and-registry-access) and create the indicated Secrets first. For an existing installation, follow the [upgrade instructions](installation.md#upgrade-an-existing-installation) to preserve its site configuration.

CPU, RAM, GPUs and disk update automatically with your selections. Values come from this documentation version’s rendered Helm manifests. Different chart versions or site overrides can change the requirements.

The inference selector defaults to [Qwen3.8 Flash-Next on one B200](installation.md#on-prem-inference), with host RAM offload and reasoning enabled. The Helm charts use the same model by default. Existing Nemotron and external options remain available.

Select Base Command Manager, then choose **Use SSH key** or **Connect to head-node MCP server** in the connection settings. The SSH option deploys the adapter using your key. For a connection without a head-node SSH key in AFOA, first follow the [head-node MCP server installation guide](bcm-external.md), then enter its HTTPS endpoint and token Secret. Both options are described in the [Base Command Manager installation section](installation.md#base-command-manager).

The optional **Read-only Redfish** checkbox appears inside the Base Command Manager module block. See the [Redfish installation guide](installation.md#read-only-redfish) for BMC credential resolution and TLS verification settings.

```{raw} html
<div id="install-command-builder"><noscript>Enable JavaScript to use the builder, or follow the <a href="installation.html">installation guide</a>.</noscript></div>
```
