# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import json
import os
import subprocess
from pathlib import Path

import yaml

project = "AI Factory Operations Agent"
copyright = "2026, NVIDIA Corporation"
extensions = ["myst_parser", "sphinx_copybutton"]
html_theme = "nvidia_sphinx_theme"
html_title = project
html_static_path = ["_static"]
html_css_files = ["docs.css"]
html_js_files = [("install-builder.mjs", {"type": "module"})]
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
exclude_patterns = [".git", ".github", "docs/.venv", "docs/_build", "helm/mosaic-stack", "AGENTS.md"]


def render_dco(app, docname, source):
    """Render the plain-text certificate without modifying its source file."""
    if docname == "DCO":
        source[0] = "# Developer Certificate of Origin\n\n```text\n" + source[0] + "\n```\n"


def setup(app):
    app.connect("source-read", render_dco)
    app.connect("build-finished", write_catalog)


ROOT = Path(__file__).resolve().parents[1]
CHART = ROOT / "helm/mosaic-stack"
MODULES = ["kubernetes", "observability", "grafana", "bcm", "slurm", "diagnostics", "research", "terminal", "edit", "clusters"]


def render_footprint(state):
    script = "import {buildCommand} from './docs/_static/install-builder.mjs'; console.log(JSON.stringify(buildCommand(JSON.parse(process.argv[1]))));"
    command = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", script, json.dumps(state)], cwd=ROOT, text=True))
    shell = 'trap \'[ -z "${MOSAIC_CHART_WORKDIR:-}" ] || rm -rf "$MOSAIC_CHART_WORKDIR"\' EXIT; helm() { if [ "$1" = pull ]; then ln -s "$CHART" "$MOSAIC_CHART_WORKDIR/mosaic-stack"; else printf \'%s\\0\' "$@"; fi; }; '
    arguments = subprocess.check_output(["bash", "-c", shell + command], env={**os.environ, "CHART": str(CHART)}, text=True).split("\0")[4:-1]
    rendered = ["template", "mosaic", str(CHART)]
    arguments = iter(arguments)
    for argument in arguments:
        if argument in {"--atomic", "--wait", "--devel"}:
            continue
        if argument in {"--timeout", "--version"}:
            next(arguments)
        elif argument == "-f":
            next(arguments)
            profile = "vllm-ultra-4gpu.yaml" if state["inference"] == "ultra" else "vllm-super-1gpu.yaml"
            rendered.extend(["-f", str(CHART / "profiles" / profile)])
        else:
            rendered.append(argument)
    output = subprocess.check_output(["helm", *rendered], text=True)
    components = {}
    for document in yaml.safe_load_all(output):
        if not document:
            continue
        kind = document.get("kind")
        spec = document.get("spec", {})
        name = document["metadata"]["name"]
        key = f"{kind}/{document['metadata'].get('namespace', 'mosaic')}/{name}"
        if kind == "PersistentVolumeClaim":
            components[key] = {"name": name, "kind": kind, "storage": spec["resources"]["requests"]["storage"], "count": 1}
        elif kind in {"Deployment", "StatefulSet", "DaemonSet", "Job", "Sandbox"}:
            pod = spec.get("template", {}).get("spec", {})
            if not pod.get("containers"):
                continue
            components[key] = {
                "name": name, "kind": kind, "count": spec.get("replicas", 1),
                "containers": [{"name": container["name"], "resources": container.get("resources", {})} for container in pod["containers"]],
                "initContainers": [{"name": container["name"], "resources": container.get("resources", {})} for container in pod.get("initContainers", [])],
                "storage": [claim["spec"]["resources"]["requests"]["storage"] for claim in spec.get("volumeClaimTemplates", [])],
                "nodeSelector": pod.get("nodeSelector", {}),
            }
    return components


def generate():
    defaults = {"inference": "external", "modules": [], "sandboxInstalled": True, "baseUrl": "https://inference.example.com/v1", "model": "served-model", "bcmHead": "head.example.com", "evidenceRoot": "/slurm", "evidenceNode": "collector-node", "corpus": "/corpus"}
    base = render_footprint(defaults)
    variants = {}
    selections = {"sandbox": {"sandboxInstalled": False}, "super": {"inference": "super"}, "ultra": {"inference": "ultra"}}
    selections.update({module: {"modules": [module]} for module in MODULES})
    selections["slurm-vanilla"] = {"modules": ["slurm"], "slurmBackend": "vanilla"}
    for name, selection in selections.items():
        rendered = render_footprint({**defaults, **selection})
        variants[name] = {key: value for key, value in rendered.items() if value != base.get(key)}
    chart = yaml.safe_load((CHART / "Chart.yaml").read_text())
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    research_available = any(key not in base and component["kind"] in {"Deployment", "StatefulSet"} for key, component in variants["research"].items())
    return {"version": chart["version"], "revision": revision, "base": base, "variants": variants, "researchAvailable": research_available}


def write_catalog(app, exception):
    if exception is None and app.builder.format == "html":
        target = Path(app.outdir) / "_static/sizing-data.json"
        target.write_text(json.dumps(generate(), indent=2) + "\n")
