# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Download the two webfonts the demo uses and write fonts.css next to them.

Nothing here is committed: NVIDIA Sans is NVIDIA's brand font, and keeping the
binaries out means the repo stays text-only.
"""
import hashlib
import pathlib
import re
import subprocess

HERE = pathlib.Path(__file__).parent
FONTS = HERE / "fonts"
FONTS.mkdir(exist_ok=True)
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36"
GOOGLE = ("https://fonts.googleapis.com/css2"
          "?family=Barlow:wght@300;400;500;600&family=JetBrains+Mono:wght@400;500&display=swap")
NVIDIA = ("https://images.nvidia.com/etc/designs/nvidiaGDC/clientlibs_base/fonts"
          "/nvidia-sans/NALA/var/NVIDIASansVF_NALA_W_Wght.woff2")


def get(url, dest=None, referer=None):
    cmd = ["curl", "-fsSL", "-A", UA]
    if referer:
        cmd += ["-e", referer]
    if dest:
        subprocess.run(cmd + [url, "-o", str(dest)], check=True)
        return None
    return subprocess.run(cmd + [url], check=True, capture_output=True, text=True).stdout


get(NVIDIA, FONTS / "NVIDIASansVF.woff2", referer="https://www.nvidia.com/")

css = get(GOOGLE)
for url in sorted(set(re.findall(r"https://fonts\.gstatic\.com/[^)]+", css))):
    name = hashlib.md5(url.encode()).hexdigest()[:10] + ".woff2"
    get(url, FONTS / name)
    css = css.replace(url, "fonts/" + name)
(HERE / "fonts.css").write_text(css)
print(f"fonts ready: {len(list(FONTS.iterdir()))} files")
