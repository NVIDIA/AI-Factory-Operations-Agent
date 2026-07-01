# Contributing to Mosaic

Contributions to Mosaic can report a problem, propose a feature, improve documentation, or implement an approved change.

## Report An Issue

Use the [issue chooser](https://github.com/NVIDIA/Mosaic/issues/new/choose) and select the form that matches the request. Include the chart version, Kubernetes version, enabled modules, reproduction steps, and sanitized logs when reporting a bug. Never include credentials, tokens, kubeconfig contents, or other secrets.

Security vulnerabilities must follow [SECURITY.md](SECURITY.md) instead of the public issue tracker.

## Propose A Change

Open an issue before substantial implementation work so maintainers can confirm scope and design. Small documentation corrections may proceed directly to a pull request.

## Code Contributions

1. Fork the repository and create a focused branch from `main`.
2. Keep changes minimal and include documentation for user-visible behavior.
3. Validate the Helm chart:

   ```bash
   helm dependency build ./helm/mosaic-stack
   helm lint ./helm/mosaic-stack
   helm template mosaic ./helm/mosaic-stack >/dev/null
   ```

4. Open a pull request using the repository template.
5. Address review feedback and ensure required status checks pass.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
