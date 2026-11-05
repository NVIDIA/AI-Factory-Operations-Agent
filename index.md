<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# AI Factory Operations Agent documentation

Deploy specialized agents to investigate cluster issues, correlate operational evidence, and integrate your AI factory systems.

:::{note}
This is an experimental release. Review the [support policy](SUPPORT.md) before installation. Private NGC artifacts require an accepted early access invitation.
:::

## Install in your environment

| Environment | Start here |
| --- | --- |
| Existing Kubernetes cluster, including early access evaluations | [Installation and configuration](docs/installation.md#custom-installation) |
| NVIDIA Mission Control admin cluster | [NVIDIA Mission Control installation](docs/nmc_installation.md) |
| Base Command Manager without Kubernetes | [Base Command Manager installation](docs/bcm.md) |
| Local development and evaluation | [Kind installation](docs/kind_installation.md) |

## Integrate and operate

Use the [Helm guide](docs/installation.md#managed-mcp-servers) to connect MCP servers to your deployment. Review the [security model](docs/security_model.md) before granting operational access, and use the [headless integration guide](docs/skills/ai-factory-operations-agent-headless/SKILL.md) for automation and coding agents.

```{toctree}
:caption: Get started
:maxdepth: 1
:hidden:

Overview <README>
Installation and configuration <docs/installation>
Installation builder <docs/installation_builder>
Mission Control installation <docs/nmc_installation>
Base Command Manager installation <docs/bcm>
Kind installation <docs/kind_installation>
```

```{toctree}
:caption: Configure and operate
:maxdepth: 1
:hidden:

Security model <docs/security_model>
Tenant and operator deployments <docs/multitenancy>
Use cases <docs/use_cases>
Slurm root cause analysis <docs/slurm_rca>
Loki query reference <docs/loki>
Headless integration <docs/skills/ai-factory-operations-agent-headless/SKILL>
```

```{toctree}
:caption: Project
:maxdepth: 1
:hidden:

CHANGELOG
SUPPORT
SECURITY
CONTRIBUTING
GOVERNANCE
MAINTAINERS
CODE_OF_CONDUCT
Developer Certificate of Origin <DCO>
IP_REVIEW
Building the documentation <docs/building>
```
