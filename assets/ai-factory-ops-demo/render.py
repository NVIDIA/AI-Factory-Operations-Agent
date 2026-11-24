# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Rasterise demo.html frame by frame with headless Chromium.

    python render.py frames              # every frame
    python render.py frames 100 101 102  # only these (renders are deterministic)
"""
import pathlib
import sys

HERE = pathlib.Path(__file__).parent

def parse_args(argv: list[str]) -> tuple[pathlib.Path, list[int] | None]:
    if len(argv) < 2:
        raise SystemExit("Usage: python render.py <output_dir> [frame ...]")

    out_dir = pathlib.Path(argv[1])
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        frame_ids = [int(x) for x in argv[2:]] or None
    except ValueError as exc:
        raise SystemExit(f"Invalid frame index: {exc}") from exc

    return out_dir, frame_ids


out, frames = parse_args(sys.argv)

from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    b = pw.chromium.launch(args=["--force-color-profile=srgb", "--disable-lcd-text"])
    pg = b.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
    pg.goto((HERE / "demo.html").as_uri())
    # Canvas fillText does not trigger webfont loading, and document.fonts.ready
    # resolves immediately when nothing has asked for a face yet. Request every
    # family/weight the demo draws with, or the first frames render in Helvetica.
    pg.evaluate("""async () => {
        await Promise.all([
            document.fonts.load("300 84px 'NVIDIA Sans'"),
            document.fonts.load("400 84px 'NVIDIA Sans'"),
            document.fonts.load("500 84px 'NVIDIA Sans'"),
            document.fonts.load("700 84px 'NVIDIA Sans'"),
            document.fonts.load("400 22px 'JetBrains Mono'"),
            document.fonts.load("500 22px 'JetBrains Mono'"),
        ]);
        await document.fonts.ready;
    }""")
    for f in frames if frames else range(pg.evaluate("window.TOTAL")):
        pg.evaluate("f => window.renderFrame(f)", f)
        pg.screenshot(path=str(out / f"f{f:05d}.png"))
        if f % 120 == 0:
            print(f, flush=True)
    b.close()
print("done")
