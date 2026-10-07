# Startup assets image

Contains the same pinned upstream kubectl, OpenShell CLI, and OpenShell plugin previously downloaded by pod init containers. Downloads and SHA-256 verification happen during image publication. Pod startup copies these files from the digest-pinned image without contacting Kubernetes, GitHub, or npm download endpoints.

The manifest lists the upstream versions, download URLs, and checksums for Linux amd64 and arm64. To update a tool, update its manifest entry, publish a new image, and select its digest in `runtimeAssets.image.digest`.

Build prerequisites: Bash, curl, GNU tar, sha256sum, and crane. Authenticate the existing Docker credential store to the target registry, then run from this directory:

```bash
./build.sh REGISTRY/mosaic-runtime-assets:SOURCE_REVISION
```

This publishes both architecture images and a multi-platform index without a Docker daemon. Build logs contain checksum results; credentials are read by crane from the existing protected Docker configuration.
