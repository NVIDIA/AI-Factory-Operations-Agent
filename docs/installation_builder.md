# Installation builder

Select your inference path and modules to generate an installation command. Complete [namespace and registry access setup](installation.md#1-create-the-namespace-and-registry-access) and create the indicated Secrets first. For an existing installation, follow the [upgrade instructions](installation.md#upgrade-an-existing-installation) to preserve its site configuration.

CPU, RAM, GPUs and disk update automatically with your selections. Values come from this documentation version’s rendered Helm manifests. Different chart versions or site overrides can change the requirements.

After installing the required modules and configuring native messaging, an
authorized operator can separately install the
[persistent background alert worker](background_alert_investigation.md).
Its host services, explicit alert filters, knowledge collections and fixed
recipient are configured in that guide; this builder leaves the site's
background-processing policy unchanged.

Select Base Command Manager to expose the optional **Read-only Redfish** checkbox inside its module block. See the [Redfish installation guide](installation.md#read-only-redfish) for BMC credential resolution and TLS verification settings.

```{raw} html
<div id="install-command-builder"><noscript>Enable JavaScript to use the builder, or follow the <a href="installation.html">installation guide</a>.</noscript></div>
```
