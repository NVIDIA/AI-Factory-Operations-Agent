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

For a site-managed endpoint, configure the advanced [MetalLB Service](installation.md#direct-ip-access-with-metallb) or [HTTPS Gateway route](installation.md#usage) settings. Port forwarding and local login remain available.

Select **Alertmanager webhook (push)** to install the optional receiver. Create
the dedicated inbound Secret and configure Alertmanager using the
[webhook guide](alertmanager_webhook.md); the generated command does not change
Alertmanager's routes. **Alertmanager alerts (pull)** configures the existing
polling endpoint. Use one delivery mode and keep the Mosaic page open for
browser-triggered Auto investigate.
[Keycloak single sign-on](installation.md#optional-keycloak-single-sign-on) is optional
and disabled by default. Normal installation and local sign-in need neither Keycloak
nor Base Command Manager LDAP federation. To opt in, configure advanced site values,
an existing client Secret and explicitly approved operator groups. The local account
and its current capabilities remain available.

```{raw} html
<div id="install-command-builder"><noscript>Enable JavaScript to use the builder, or follow the <a href="installation.html">installation guide</a>.</noscript></div>
```
