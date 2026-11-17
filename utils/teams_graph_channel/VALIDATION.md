<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Delegated Graph bridge validation, 2026-11-17

An isolated telemetry simulation produced a real Prometheus alert, which reached the bridge through Alertmanager. MOSAIC investigated through its own tools, consulted Research, and delivered a report to Teams. A human then sent an ordinary follow-up without a Run ID; the worker automatically used the same MOSAIC conversation and returned a second report. An operator did not relay that follow-up or supply either model answer.

This is one live integration run, not a latency benchmark or evidence of production readiness. Deployment identities, private endpoints and raw infrastructure payloads stay in the owner's internal evidence archive. The tables below retain every measured tool result and the exact timing values from that run.

## Timeline

| Event | UTC |
|---|---|
| Alert firing | 2026-11-17T07:49:55.229Z |
| Webhook received | 2026-11-17T07:50:00.254Z |
| Initial Agent turn started | 2026-11-17T07:50:02.683Z |
| Initial reply accepted by Graph | 2026-11-17T07:50:58.588Z |
| Initial turn recorded done | 2026-11-17T07:50:58.829Z |
| Human follow-up created in Teams | 2026-11-17T07:53:16.236Z |
| Follow-up Agent turn started | 2026-11-17T07:53:19.821Z |
| Follow-up reply accepted by Graph | 2026-11-17T07:54:57.235Z |
| Follow-up turn recorded done | 2026-11-17T07:54:57.432Z |
| Isolated fixture cleanup completed | 2026-11-17T07:57:53.027079Z |

Alert firing to reply: **63.359 seconds**. Human follow-up to reply: **100.999 seconds**. These intervals include queueing, model and tool work, and Graph submission; a 10-second poll is not a 10-second response-time guarantee.

## Every tool result

`messageCharacters` counts Python Unicode characters in the captured tool-result text, not bytes or model tokens. Success means the tool returned successfully; it does not establish that the model's subsequent interpretation was correct.

| Turn | Sequence | Tool | Success | messageCharacters |
|---|---:|---|---|---:|
| Initial | 1 | run_kubectl | true | 388 |
| Initial | 2 | run_kubectl | true | 11314 |
| Initial | 3 | run_kubectl | true | 1570 |
| Initial | 4 | run_kubectl | true | 37322 |
| Initial | 5 | iraop_list_collections | true | 177 |
| Initial | 6 | observability_query | true | 951 |
| Initial | 7 | iraop_list_documents | true | 174 |
| Initial | 8 | iraop_list_documents | true | 180 |
| Initial | 9 | observability_range_query | true | 2475 |
| Initial | 10 | iraop_query | true | 4251 |
| Initial | 11 | iraop_get_document | true | 182 |
| Follow-up | 1 | run_kubectl | true | 11314 |
| Follow-up | 2 | run_kubectl | true | 388 |
| Follow-up | 3 | observability_query | true | 951 |
| Follow-up | 4 | iraop_query | true | 5277 |

The first turn retrieved Pod state, telemetry logs, events, node data, instant/range metrics and Research documents. The follow-up retrieved Pod logs/state, metrics and another Research answer. The second turn referred to the correct previous alert without the user repeating its identity.

## Formatting repair

The original automatic sends used plain text, causing Markdown headings and tables to appear literally. The current implementation renders escaped Graph v1.0 HTML. The two already-delivered reports were subsequently repaired in place through delegated Graph PATCH, with a GET before and after. The repair invoked no model and sent no additional message. Graph normalized HTML serialization; normalized visible text in its readback matched the requested rendering.

| Report | Original characters | Original UTF-8 bytes | Readback HTML UTF-8 bytes | Repair UTC | Same message | Readback type |
|---|---:|---:|---:|---|---|---|
| Initial | 3722 | 5525 | 7565 | 2026-11-17T08:14:03.745Z | yes | html |
| Follow-up | 3126 | 5036 | 6975 | 2026-11-17T08:12:33.887Z | yes | html |

The HTML send path has automated coverage. Live HTML acceptance/readback was verified by PATCH on these reports; a new post-deployment automatic HTML reply has not yet been separately witnessed. Do not describe that as an additional live conversation test.

## Safety and diagnosis boundaries

- Injection changed a private DCGM cache only: field 230 = 95, 311 = 1 and 313 = 1. No physical GPU error was injected. The private engine stopped after sampling.
- Cleanup deleted all 6 temporary Kubernetes objects. All 39 pre-existing Prometheus rules retained their identities/specifications; the before/after counters for all 8 GPUs were unchanged.
- Both Agent turns used View mode. There were no infrastructure repair, reset or drain tool calls.
- Re-reading a replay Pod's logs is not fresh NVML/kernel collection. The follow-up did not acquire new `nvidia-smi`/`dmesg` evidence, so it does not validate complete hardware fault diagnosis.
- The raw model reports contain an incorrect UTC attribution for a host-local timestamp and incorrect wording about double-bit ECC. Absence of a kernel log or counter change alone is not conclusive evidence of no hardware fault. The original answers are retained in the private archive rather than silently corrected.
- Long-duration authentication renewal, throttling/recovery, multiple users, attachments and governed infrastructure writes remain unverified.

## Reproducible local checks

From the repository root:

```bash
node --test utils/teams-graph-probe.test.mjs utils/teams_graph_channel/*.test.mjs
python3 utils/teams_graph_channel/test_prepare.py
```

Result: **24 Node tests passed**, plus **9 Python runner tests** invoked by the existing probe suite and **3 manifest-generator Python tests**. Tests cover identity/default-scope compatibility, no-send binding, allowlisted intake and restart deduplication, ordered pagination, recovery without resubmission, ambiguous-send handling, simulation-alert filtering, concurrent durable writes, HTML escaping/complete output, and ownership checks for formatting repair.

The reused probe's new `bind` mode also passed against the existing live chat: token acquisition, `/me` and `/chats`, with no `/messages` request. A manifest generated from that binding passed Kubernetes server-side dry-run; it was not applied over the existing conversation binding.
