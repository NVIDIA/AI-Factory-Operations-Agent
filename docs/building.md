<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Building the documentation

The documentation site uses NVIDIA's Sphinx theme and renders the Markdown guides directly. Edit the original guides rather than creating separate HTML content.

## Build and preview

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), Node.js and Helm, and prepare the chart dependencies with `helm dependency build helm/mosaic-stack` (private registry access is required for the research dependency). Then run from the repository root:

```bash
uv run --project docs --locked sphinx-build -W --keep-going -b html -c docs . docs/_build/html
uv run --project docs python -m http.server 8080 --directory docs/_build/html
```

Open `http://localhost:8080`. The build treats warnings as errors, including broken document references. Generated HTML and the documentation virtual environment are ignored by Git.

## GitHub Pages

The footprint catalog is generated during each HTML build by rendering the tracked chart with the builder's own commands. The public documentation workflow does not authenticate to the private research registry; it uses an empty research dependency solely for rendering the public chart. Research workloads are consequently marked unavailable in that build. With an authorized real dependency installed locally, its manifests are included. Never deploy the documentation/test placeholder dependency.

The documentation workflow builds pull requests without publishing. After a change lands on `main`, it publishes the generated static site to GitHub Pages using the `github-pages` environment. A repository administrator must first enable **Settings → Pages → Build and deployment → Source: GitHub Actions**.

The intended URL is `https://nvidia.github.io/AI-Factory-Operations-Agent/`. Until Pages is enabled and a deployment succeeds, that URL will not serve the documentation. No registry or inference credentials are needed for the documentation build.
