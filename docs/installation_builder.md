# Installation builder

Select your inference path and modules to generate an installation command. Complete [namespace and registry access setup](installation.md#1-create-the-namespace-and-registry-access) and create the indicated Secrets first. For an existing installation, follow the [upgrade instructions](installation.md#upgrade-an-existing-installation) to preserve its site configuration.

CPU, RAM, GPUs and disk update automatically with your selections. Values come from this documentation version’s rendered Helm manifests. Different chart versions or site overrides can change the requirements.

Select **Alertmanager webhook (push)** to install the optional receiver. Create
the dedicated inbound Secret and configure Alertmanager using the
[webhook guide](alertmanager_webhook.md); the generated command does not change
Alertmanager's routes. **Alertmanager alerts (pull)** configures the existing
polling endpoint. Use one delivery mode and keep the Mosaic page open for
browser-triggered Auto investigate.

```{raw} html
<div id="install-command-builder"><noscript>Enable JavaScript to use the builder, or follow the <a href="installation.html">installation guide</a>.</noscript></div>
```
