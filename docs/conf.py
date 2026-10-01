# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

project = "AI Factory Operations Agent"
copyright = "2026, NVIDIA Corporation"
extensions = ["myst_parser", "sphinx_copybutton"]
html_theme = "nvidia_sphinx_theme"
html_title = project
html_static_path = ["_static"]
html_css_files = ["docs.css"]
html_theme_options = {
    "navigation_depth": 3,
    "show_nav_level": 2,
    "show_toc_level": 2,
    "navbar_center": [],
    "icon_links": [{"name": "GitHub", "url": "https://github.com/NVIDIA/AI-Factory-Operations-Agent", "icon": "fa-brands fa-github"}],
}
html_context = {
    "github_user": "NVIDIA",
    "github_repo": "AI-Factory-Operations-Agent",
    "github_version": "main",
    "doc_path": "",
}
myst_enable_extensions = ["colon_fence", "strikethrough", "tasklist"]
myst_heading_anchors = 4
exclude_patterns = [".git", ".github", "docs/.venv", "docs/_build", "helm/mosaic-stack", "AGENTS.md", "DCO.md"]
