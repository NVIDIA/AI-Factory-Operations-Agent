---
name: iraop
description: "Research NVIDIA DGX, SuperPOD, GB200, NVLink, BlueField, BCM, and on-prem infrastructure documentation through the IRA/Sequoia retrieval agent. Use when the user asks to research docs, deployment policy, operational guidance, or newly uploaded knowledge-base documents."
metadata:
  {
    "openclaw":
      {
        "emoji": "search",
        "requires": { "tools": ["iraop_query", "iraop_list_collections", "iraop_list_documents", "iraop_get_document"] }
      }
  }
---

# iraop — IRA Documentation Research

Use the `iraop_query` tool for documentation-backed research.

Default to `depth: "quick"` unless the user explicitly asks for deep research or the question needs a multi-step plan grounded in documentation. Use `depth: "deep"` for deployment-policy recommendations, operational plans, or questions that should synthesize multiple documents.

If the user references uploaded knowledge, first use `iraop_list_collections` or pass the likely collection name to `iraop_query` when known.

Return practical SRE-oriented output: findings, caveats, and exact safe commands when the user asks for commands. Do not create GPU pods unless the user explicitly requests a real rollout.
