# Building the documentation

The documentation site uses NVIDIA's Sphinx theme and renders the Markdown guides directly. Edit the original guides rather than creating separate HTML content.

## Build and preview

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then run from the repository root:

```bash
uv run --project docs --locked sphinx-build -W --keep-going -b html -c docs . docs/_build/html
uv run --project docs python -m http.server 8080 --directory docs/_build/html
```

Open `http://localhost:8080`. The build treats warnings as errors, including broken document references. Generated HTML and the documentation virtual environment are ignored by Git.

## GitHub Pages

The documentation workflow builds pull requests without publishing. After a change lands on `main`, it publishes the generated static site to GitHub Pages using the `github-pages` environment. A repository administrator must first enable **Settings → Pages → Build and deployment → Source: GitHub Actions**.

The intended URL is `https://nvidia.github.io/AI-Factory-Operations-Agent/`. Until Pages is enabled and a deployment succeeds, that URL will not serve the documentation. No registry or inference credentials are needed for the documentation build.
