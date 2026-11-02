# Installation builder

Select your inference path and modules to generate an installation command. Complete [namespace and registry access setup](installation.md#1-create-the-namespace-and-registry-access) and create the indicated Secrets first. For an existing installation, follow the [upgrade instructions](installation.md#upgrade-an-existing-installation) to preserve its site configuration.

CPU, RAM, GPUs and disk update automatically with your selections. Values come from this documentation version’s rendered Helm manifests. Different chart versions or site overrides can change the requirements.

Select **Automatic alert investigation** to install the
[native alert automation plugin](alert_automation_plugin.md). Configure the
native messaging application first, then supply its channel, fixed report target
and verified recipient conversation. The generated settings use Alertmanager
polling. The plugin guide covers source filters, webhook intake, credentials and
migration from the retained deployment-host worker.

Select Base Command Manager to expose the optional **Read-only Redfish** checkbox inside its module block. See the [Redfish installation guide](installation.md#read-only-redfish) for BMC credential resolution and TLS verification settings.

```{raw} html
<div id="install-command-builder"><noscript>Enable JavaScript to use the builder, or follow the <a href="installation.html">installation guide</a>.</noscript></div>
```
