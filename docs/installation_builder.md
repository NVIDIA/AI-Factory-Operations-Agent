# Installation builder

Select your inference path and modules to generate an installation command. Complete [namespace and registry access setup](installation.md#1-create-the-namespace-and-registry-access) and create the indicated Secrets first. For an existing installation, follow the [upgrade instructions](installation.md#upgrade-an-existing-installation) to preserve its site configuration.

Resources update automatically with the selections above. An existing endpoint, including a cloud LLM, requires no local model-server GPUs. Expand **Component resource settings** to see the selected modules and their dependencies. Values come from rendered Helm manifests, including init containers and persistent volumes. “Not set in chart” means a CPU or memory request or limit is absent, so totals are partial configuration values rather than production sizing recommendations. Per-node collectors, dynamic sandboxes and existing infrastructure are excluded from the workload subtotal.

The calculator does not fetch arbitrary published chart versions. A different chart channel, pinned release, site override or GPU profile can change the footprint. Verify the target chart and model compatibility before deployment.

```{raw} html
<div id="install-command-builder"><noscript>Enable JavaScript to use the builder, or follow the <a href="installation.html">installation guide</a>.</noscript></div>
```
