# Installation builder

Select your inference path and modules to generate an installation command. Complete [namespace and registry access setup](installation.md#1-create-the-namespace-and-registry-access) and create the indicated Secrets first. For an existing installation, follow the [upgrade instructions](installation.md#upgrade-an-existing-installation) to preserve its site configuration.

CPU, RAM, GPUs and disk update automatically with your selections. Values come from this documentation version’s rendered Helm manifests. Different chart versions or site overrides can change the requirements.

Select Base Command Manager to expose the optional **Read-only Redfish** checkbox inside its module block. See the [Redfish installation guide](installation.md#read-only-redfish) for BMC credential resolution and TLS verification settings.

Select Research to expose the optional **Search tool compatibility workaround** checkbox. Leave it off unless the inference backend returns named search arguments as ordinary text and the agent fails to execute the search. See [research evidence validation](installation.md#research) and [the compatibility guide](installation.md#optional-research-tool-compatibility) for the supported schema and verification steps. The builder does not enable full request-body tracing; temporary tracing requires separate controlled configuration and export.

```{raw} html
<div id="install-command-builder"><noscript>Enable JavaScript to use the builder, or follow the <a href="installation.html">installation guide</a>.</noscript></div>
```
