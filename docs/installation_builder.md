# Installation builder

Select your inference path and modules to generate an installation command. Complete [namespace and registry access setup](installation.md#1-create-the-namespace-and-registry-access) and create the indicated Secrets first. For an existing installation, follow the [upgrade instructions](installation.md#upgrade-an-existing-installation) to preserve its site configuration.

The deployment footprint updates with the selections above. It is generated from this documentation revision's rendered Helm manifests, including module dependencies, init containers and persistent volumes. Requests and limits are configuration values, not production capacity recommendations. Unspecified resources and per-node collectors prevent a complete cluster-wide total. Dynamic sandboxes and existing infrastructure are excluded.

The calculator does not fetch arbitrary published chart versions. A different chart channel, pinned release, site override or GPU profile can change the footprint. Verify the target chart and model compatibility before deployment.

```{raw} html
<div id="install-command-builder"><noscript>Enable JavaScript to use the builder, or follow the <a href="installation.html">installation guide</a>.</noscript></div>
```
