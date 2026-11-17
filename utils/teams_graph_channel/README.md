<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Optional delegated Graph conversation bridge

A successful one-shot Graph send does not receive the user's next message. This optional worker polls one verified Teams DM, submits new messages to the existing MOSAIC headless API, and returns the complete assistant answer to the same chat. It preserves the conversation when a simulation alert starts the investigation and a person follows up.

This is an experimental, single-user, **View-only** transport. The MOSAIC runtime performs reasoning and tool calls. It is not the native OpenClaw Teams Bot channel, and does not require n8n. It does not enable infrastructure mutation or replace the existing channel configuration.

## Relationship to existing Teams work

| Existing work | Reuse / boundary |
|---|---|
| [Upstream #71](https://github.com/NVIDIA/AI-Factory-Operations-Agent/pull/71) | Native Bot registration, ingress and OpenClaw channel; uses a different authentication/transport path. |
| [Upstream #76](https://github.com/NVIDIA/AI-Factory-Operations-Agent/pull/76) | This branch builds on its fixes and reuses `utils/teams_graph_probe/probe.cjs`. New `bind` mode verifies the service identity and creates/reuses a fixed DM without sending a message. Existing identity/send modes remain unchanged. |
| [Fork #4](https://github.com/JeffPengCoder/AI-Factory-Operations-Agent/pull/4) / [upstream #96](https://github.com/NVIDIA/AI-Factory-Operations-Agent/pull/96) | n8n transport is independent. This worker uses Graph directly; it neither deploys n8n nor reopens the withdrawn upstream PR. |

## Prerequisites

- Existing MOSAIC with `/api/headless/chat`, `/api/openclaw/chat` and the UI machine-token Secret. The headless API must enforce View mode. The fixed session name uses the existing `mosaic-automation-alert-` automation scope.
- Approved delegated Entra application, a Teams-enabled service account, and a distinct recipient in the same tenant. This pilot uses password grant **only when the tenant permits that flow**. MFA/Conditional Access rejection requires an approved alternative authentication flow; this worker does not bypass it.
- Delegated `User.Read`, `Chat.Create`, `Chat.ReadWrite`, `ChatMessage.Send`, with required consent completed. A mailbox alone does not prove Teams entitlement.
- Node 22+, Python 3, kubectl; network access to Microsoft login/Graph and the MOSAIC UI. A persistent storage class and the OpenClaw image used in the template must be available.

## Bind and deploy

Run in this directory. Keep actual credentials outside the source checkout. Get the recipient's Entra object ID from the tenant's user directory (or their authenticated Graph `/me` response).

```bash
umask 077
W="$HOME/mosaic-teams-private"
mkdir -p "$W"
cp credentials.example.json "$W/credentials.json"
# Edit all five fields in the private JSON using an editor.
chmod 600 "$W/credentials.json"

MOSAIC_TEAMS_CREDENTIAL_FILE="$W/credentials.json" \
MOSAIC_TEST_RUN_ID=teams-bind-initial \
MOSAIC_TEST_PROBE_MODE=bind \
MOSAIC_TEAMS_RECIPIENT_ID=33333333-3333-3333-3333-333333333333 \
node ../teams_graph_probe/probe.cjs > "$W/binding.json"
```

A successful result has `stage: bound`. The probe emits no passwords/tokens and makes no message-send request in this mode. Do not continue on a failed result. The worker subsequently verifies the chat type and both actual members again before processing anything.

```bash
NS=mosaic
kubectl config current-context
python3 prepare.py --binding "$W/binding.json" --namespace "$NS" \
  --storage-class standard --ui-secret mosaic-ui-auth \
  --mosaic-url http://mosaic-ui:3000 --output "$W/deployment.json"
kubectl -n "$NS" create secret generic mosaic-teams-graph \
  --from-file=credentials.json="$W/credentials.json"
kubectl apply --dry-run=server -f "$W/deployment.json"
kubectl apply -f "$W/deployment.json"
kubectl -n "$NS" rollout status deployment/mosaic-teams-graph --timeout=180s
kubectl -n "$NS" logs deployment/mosaic-teams-graph --tail=30
```

Use the existing namespace, UI service, Secret and storage class for your installation. Do not change the chat or session binding while reusing its PVC. For an existing bridge, retain its `channel.json` when updating code; source/config checksums in the Deployment trigger a rollout. The native Bot and other IM channels are configured independently.

Send a **new** ordinary Teams message from the configured recipient to the service account after `ready` appears. The worker ignores pre-activation history and its own messages. No confirmation to an operator is needed. `incoming_queued`, `agent_completed`, and `reply_sent` associate the actual incoming/run/outgoing IDs.

## Rendering and complete output

Graph v1.0's `chatMessage.body` supports `text` and `html`; Bot Framework's `textFormat` is not the Graph request field. Sending Markdown as plain text displays `##`, `**` and table separators literally. `format.mjs` emits escaped HTML paragraphs, bold headings, code blocks, links and label/value table rows. All rows and columns remain present; large blocks split at Unicode boundaries and each HTML message stays within 18,000 UTF-8 bytes. The original model answer, outgoing parts and Graph receipts remain on the PVC.

An operator can repair **one recorded, single-message answer** already sent by this account. The tool verifies the saved receipt, sender and unchanged original text before PATCH. It does not invoke a model or send a new message; a before/after record is saved separately without rewriting the original state evidence.

```bash
kubectl -n "$NS" exec deployment/mosaic-teams-graph -- \
  node /config/reformat.mjs /config/channel.json MESSAGE_ID
```

## Optional simulation-alert intake

Regenerate the manifest with `--test-alert-cluster your-configured-cluster`. Create Secret `mosaic-teams-alert-webhook` with a random `token` file (at least 32 characters), then apply the manifest. The service listens on port 8789, path `/alertmanager`. Make it reachable privately from Alertmanager; use authenticated HTTPS when crossing an untrusted network. Do not expose a plaintext bearer-token endpoint publicly.

```bash
openssl rand -hex 32 > "$W/webhook-token"
kubectl -n "$NS" create secret generic mosaic-teams-alert-webhook \
  --from-file=token="$W/webhook-token"
```

Merge the following receiver and route into the existing Alertmanager configuration; keep its existing routes. The `credentials_file` path must be mounted into **Alertmanager** and contain the same token. Replace `your-configured-cluster` in both the worker and route.

```yaml
# Append to receivers:
- name: teams-simulation
  webhook_configs:
    - url: http://mosaic-teams-graph.mosaic.svc:8789/alertmanager
      send_resolved: true
      http_config:
        authorization:
          type: Bearer
          credentials_file: /etc/alertmanager/teams-token/token
# Add to route.routes:
- receiver: teams-simulation
  matchers:
    - teams_validation="true"
    - mosaic_test="true"
    - simulation="true"
    - cluster="your-configured-cluster"
  group_by: [namespace, alertname, run_id]
  group_wait: 5s
  group_interval: 5s
  repeat_interval: 12h
  continue: false
```

Only matching **firing simulation alerts** are queued; `run_id` and `startsAt` are required. The persistent key combines fingerprint, Run ID and start time. Resolved updates do not start another investigation. This pilot does not accept general production alerts. The prompt asks MOSAIC to collect evidence and consult registered IRAOP tools; no results are manufactured if those tools are unavailable.

## Behavior, failure handling and scope

| Item | Behavior |
|---|---|
| Teams intake | 10-second poll; 50 messages/page; ordered pagination; 5-minute overlap; durable ID deduplication. Investigation duration is additional. |
| Conversation | One fixed service identity, recipient, one-to-one chat and View session; sequential processing. |
| State | PVC; atomic fsync/rename; queued/running/ready/send_uncertain/done/failed; complete inputs, answers and receipts. |
| Unconfirmed Agent submission | Read the same session; do not blindly resubmit. |
| Unconfirmed outbound send | Save intent and stop automatic resend; operator review required. This chooses duplicate avoidance over guaranteed retry. |
| Authentication | Read the mounted file for each new login; cache the token; halt on authentication failure without password retry loops. |
| Limitations | One textual DM only; no attachments, group support, multi-user queue, automatic recovery of uncertain sends, or credential-rotation integration. |
| Operational validation still needed | Long-duration renewal, Graph throttling, concurrent-user scaling, real hardware faults, and governed write actions. |

Stop/start without deleting state:

```bash
kubectl -n "$NS" scale deployment/mosaic-teams-graph --replicas=0
kubectl -n "$NS" scale deployment/mosaic-teams-graph --replicas=1
```

## Validation

```bash
node --test utils/teams-graph-probe.test.mjs utils/teams_graph_channel/*.test.mjs
python3 utils/teams_graph_channel/test_prepare.py
```

Run these commands from the repository root. [Live validation summary](VALIDATION.md) distinguishes successful transport/tool invocation from diagnosis quality. Public evidence omits deployment identities and addresses; complete private records remain with the deployment owner.

References: [Graph chatMessage body](https://learn.microsoft.com/en-us/graph/api/resources/chatmessage?view=graph-rest-1.0), [send](https://learn.microsoft.com/en-us/graph/api/chatmessage-post?view=graph-rest-1.0), [update](https://learn.microsoft.com/en-us/graph/api/chatmessage-update?view=graph-rest-1.0), [list/pagination](https://learn.microsoft.com/en-us/graph/api/chat-list-messages?view=graph-rest-1.0).
