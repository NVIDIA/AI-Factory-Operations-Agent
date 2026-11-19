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

## Group-chat extension, 2026-11-19

The earlier acceptance above covers the November 17 DM implementation. The November 19 change adds an independently bound group, mandatory structured service-account mentions and an explicit user allowlist. The existing DM configuration/state remain compatible.

| Check | Observed result |
|---|---|
| Repository Node CI suite | 298 tests: 296 passed, 2 existing conditional skips, 0 failed. The root `utils/teams-graph-channel.test.mjs` entry now runs bridge and manifest checks in the existing CI glob. |
| Focused probe/bridge Node tests | 36 passed, 0 failed before adding the root manifest-test wrapper; the wrapper adds 1 test. |
| Python tests | Existing probe runner: 9 passed; manifest generator: 5 passed. |
| Group eligibility coverage | Real mention identity and matching HTML marker; unmentioned chat, name-only spoof, other mention target, non-allowlisted member, nonmember, service-account messages, deleted messages and old history do not run. |
| Membership and state coverage | Paginated membership, wrong chat type, removed service, malformed/looping pagination, sender revoked before execution or during investigation, DM/group PVC binding, separate group session and same-chat reply. |
| Actual Graph group binding | One existing group and 3 explicitly approved human members verified; no chat/member mutation or test message. |
| Kubernetes dry-run | Separate ConfigMap, PVC and Deployment accepted. |
| Group worker activation | 2026-11-19T06:30:58.857Z; `ready` at 06:31:01.963Z, View mode, 10-second polling, mandatory @, 3 allowed users, no historical replay. |
| Existing services | DM, OpenClaw/Feishu, model proxy and UI Deployment UIDs and complete specs were unchanged by adding the group. |

Two initial binding attempts failed at transport setup before any Entra response (`events=[]`), not with a consent or account error. The second reported `ETIMEDOUT` in 2.032 seconds. Three unauthenticated Microsoft connectivity checks using Node's 2,000 ms per-address selection window returned HTTP 200 in 1,175 ms, 682 ms and 403 ms. With that setting, the actual binding and group worker login succeeded. These are a diagnosis of this deployment's connection behavior, not a broad network benchmark or a reason to retry invalid passwords.

Two new human @ messages subsequently completed automatically in that group. The first asked about previous tasks; the fresh group session did not inherit the older DM. The second requested a cluster check. Both answers were rendered as HTML and accepted by Graph in the same group, using the same group MOSAIC session. No operator submitted the prompts or authored/sent the answers.

| Event | First group turn UTC | Second group turn UTC |
|---|---|---|
| Human message created | 2026-11-19T06:32:42.265Z | 2026-11-19T06:33:24.945Z |
| Worker queued | 2026-11-19T06:32:50.924Z | 2026-11-19T06:33:27.215Z |
| Agent started, event log | 2026-11-19T06:32:51.592Z | 2026-11-19T06:33:27.964Z |
| Agent completed | 2026-11-19T06:33:00.878Z | 2026-11-19T06:34:03.549Z |
| Graph outgoing message created | 2026-11-19T06:33:03.114Z | 2026-11-19T06:34:05.016Z |
| Send receipt recorded | 2026-11-19T06:33:03.368Z | 2026-11-19T06:34:05.314Z |
| Human message to send receipt | 21.103 seconds | 40.369 seconds |
| Answer characters / HTML parts | 140 / 1 | 969 / 1 |

Every native tool-result observation follows. `isError` is the runtime's flag, not an assertion that the returned evidence supports the model's interpretation; character counts include the complete recorded text, even when a tool itself bounds its output.

| Turn | Sequence | Tool | Result UTC | isError | Text characters |
|---|---:|---|---|---|---:|
| First group | 1 | sessions_history | 06:32:57.258Z | false | 1683 |
| First group | 2 | memory_search | 06:32:57.259Z | false | 171 |
| Second group | 1 | run_kubectl | 06:33:31.068Z | false | 551 |
| Second group | 2 | run_kubectl | 06:33:31.070Z | false | 5229 |
| Second group | 3 | exec | 06:33:31.072Z | true | 167 |
| Second group | 4 | run_kubectl | 06:33:38.987Z | false | 63952 |
| Second group | 5 | run_kubectl | 06:33:38.993Z | false | 63954 |
| Second group | 6 | run_kubectl | 06:33:52.409Z | false | 653 |
| Second group | 7 | run_kubectl | 06:33:52.410Z | false | 527 |

This demonstrates automatic group transport and native tool execution for one human participant across two turns. The two other allowlisted people have not each been live-tested. It does not validate every diagnosis: the model used `status.phase!=Running,status.phase=Succeeded` (which selects Succeeded Pods, not all unhealthy Pods), omitted an explicit cluster argument, encountered a failed `exec`, and made conclusions about health/cleanup that require separate review. The transport does not turn those statements into permission to modify infrastructure.
