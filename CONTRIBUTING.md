# Contributing to AI Factory Operations Agent

Contributions to AI Factory Operations Agent can report a problem, propose a feature, improve documentation, or implement an approved change.

## Report An Issue

Use the [issue chooser](https://github.com/NVIDIA/AI-Factory-Operations-Agent/issues/new/choose) and select the form that matches the request. Include the chart version, Kubernetes version, enabled modules, reproduction steps, and sanitized logs when reporting a bug. Never include credentials, tokens, kubeconfig contents, or other secrets.

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

## Developer Certificate Of Origin

External contributions require agreement to the [Developer Certificate of Origin 1.1](DCO.md). Every commit must include a `Signed-off-by` line. Add it automatically with the `-s` option:

```bash
git commit -s -m "Describe the change"
```

The sign-off adds a `Signed-off-by: Name <email@example.com>` line and certifies the contribution under the DCO. Pull requests containing unsigned commits cannot be merged.

### Full Text Of The DCO

```text
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

NVIDIA maintainers also apply the project [IP review process](IP_REVIEW.md) before accepting or distributing third-party contributions.

By participating, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
