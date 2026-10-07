#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
umask 022

image=${1:?Usage: build.sh REGISTRY/IMAGE:TAG}
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
base=alpine@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
build_dir=$(mktemp -d)
trap 'rm -rf -- "$build_dir"' EXIT
manifests=()
for architecture in amd64 arm64; do
    root="$build_dir/$architecture"
    assets="$root/opt/mosaic-assets"
    mkdir -p "$assets"
    while IFS=$'\t' read -r platform name sha url; do
        [[ "$platform" == "$architecture" || "$platform" == all ]] || continue
        curl -fsSL --retry 5 --retry-all-errors -o "$assets/$name" "$url"
        printf '%s  %s\n' "$sha" "$assets/$name" | sha256sum -c -
    done < "$source_dir/assets.tsv"
    chmod 0555 "$assets/kubectl"
    tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -czf "$root.tgz" -C "$root" opt
    reference="$image-$architecture"
    crane append --platform "linux/$architecture" --base "$base" --new_layer "$root.tgz" --new_tag "$reference"
    manifests+=(--manifest "$reference")
done
crane index append "${manifests[@]}" --tag "$image"
crane digest "$image"
