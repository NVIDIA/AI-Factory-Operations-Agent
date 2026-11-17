# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Bundle tracked Markdown for the agent workspace; --check verifies freshness."""
import gzip
import io
from pathlib import Path
import subprocess
import sys
import tarfile

root = Path(__file__).resolve().parents[1]
output = root / "helm/mosaic-stack/files/agent-documentation.tar.gz"
paths = subprocess.check_output(
    ["git", "ls-files", "-z", "README.md", "docs"], cwd=root
).decode().split("\0")
archive = io.BytesIO()
with tarfile.open(fileobj=archive, mode="w") as tar:
    for name in sorted({name for name in paths if name.endswith(".md")}):
        content = (root / name).read_bytes()
        entry = tarfile.TarInfo(name)
        entry.size, entry.mode = len(content), 0o644
        tar.addfile(entry, io.BytesIO(content))
compressed = io.BytesIO()
with gzip.GzipFile(fileobj=compressed, mode="wb", filename="", mtime=0) as stream:
    stream.write(archive.getvalue())
bundle = compressed.getvalue()
if "--check" in sys.argv:
    if not output.exists() or output.read_bytes() != bundle:
        sys.exit("Agent documentation is stale: run uv run --no-project docs/package_agent_docs.py")
else:
    output.write_bytes(bundle)
