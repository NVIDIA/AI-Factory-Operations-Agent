---
name: iraop
description: "Research NVIDIA DGX, SuperPOD, GB200, NVLink, BlueField, Base Command Manager (BCM), and on-prem infrastructure documentation through the IRA/Sequoia retrieval agent. Use when the user asks to research docs, deployment policy, operational guidance, or newly uploaded knowledge-base documents."
metadata:
  {
    "openclaw":
      {
        "emoji": "search",
        "requires": { "tools": ["iraop_query", "iraop_list_collections", "iraop_list_documents", "iraop_get_document"] }
      }
  }
---

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# iraop — IRA Documentation Research

Use the `iraop_query` tool for documentation-backed research.

For an operational investigation, first gather the workload's selected resources, observed symptom and constraints. Include those facts in the research question and ask for applicable diagnostic checks and their prerequisites. A bare health-check label does not identify a cause. Keep unrelated findings out of the remedy question unless live evidence connects them to the affected path.

Research returns documentation, not observations of the running cluster. Before acting on a recommendation, verify its prerequisite on the affected resource with a live read. Keep an explicit distinction between a documented possibility, an observed condition and a cause demonstrated by a controlled comparison. If a change does not improve the measured symptom, it has not resolved the task. Never infer normal performance from the absence of a successful remedy; that claim requires a matching benchmark reference.

Reuse an existing research answer until new live evidence creates a different question. Rephrasing the same question without new evidence does not advance the investigation.

Default to `depth: "quick"` unless the user explicitly asks for deep research or the question needs a multi-step plan grounded in documentation. Use `depth: "deep"` for deployment-policy recommendations, operational plans, or questions that should synthesize multiple documents.

If the user references uploaded knowledge, first use `iraop_list_collections` or pass the likely collection name to `iraop_query` when known.

Return practical SRE-oriented output: findings, caveats, and exact safe commands when the user asks for commands. Do not create GPU pods unless the user explicitly requests a real rollout.

When the user asks for a safe Kubernetes configuration command, put the command in a fenced code block and use `kubectl apply -f - <<EOF` with inert resources such as namespaces or ConfigMaps. Never output `kubectl create` for this workflow, including namespace or ConfigMap examples; use apply-style YAML only.
