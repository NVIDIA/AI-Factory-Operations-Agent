<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Native alert automation plugin

The optional `alert-automation` OpenClaw plugin receives Alertmanager alerts,
starts one native Agent investigation, retains the complete report, and sends it
through an operator-selected native messaging channel. MOSAIC installs and
configures the plugin through Helm. No deployment-host Python process, systemd
unit, `kubectl exec` publisher, browser tab, or periodic LLM wake-up is required.

The plugin is a background **Service**, with a prompt hook for report context.
Diagnostic Skills and tools remain the selected Agent's existing capabilities.
It uses OpenClaw 2026.6.10's `registerService`, native subagent runtime, outbound
adapter registry, and `before_prompt_build` hook. It does not modify OpenClaw
core or the private MOSAIC UI image.

```text
Alertmanager webhook and/or plugin HTTP polling
  -> durable SQLite incident queue on openclaw-home-pvc
  -> one native Agent goal in a View-only automation session
     -> Agent selects evidence, tools, order, and optional IRAOP research
  -> complete original report and complete actual tool history
  -> persistent report binding to the selected recipient conversation
  -> configured native channel outbound adapter
  -> user follow-up: native prompt hook supplies the complete bound report
```

The plugin's Agent, channel, account, target and recipient session are explicit
configuration. A channel needs an installed, configured native outbound adapter
with `sendText`; Feishu-specific IDs and credentials are not embedded in the
implementation. Installing a channel plugin is separate from authorizing an
application in that messaging platform.

## Enable with Helm

The feature is disabled by default. Create an operator-owned values file:

```yaml
modules:
  alertAutomation:
    enabled: true
    sourceMode: poll
    alertmanagerUrl: https://alerts.example.com/alertmanager
    matchLabels:
      automation: "enabled"
    includeExisting: false
    pollSeconds: 30
    timeoutSeconds: 900
    maxPending: 100
    agentId: default
    stateDirectory: alert-automation
    messagePrefix: MOSAIC automated alert report
    reportLanguage: English
    investigationContext: ""
    redactValues: []
    delivery:
      channel: feishu
      target: chat:oc_REPLACE_WITH_TARGET_CHAT
      sessionKey: agent:default:feishu:direct:ou_REPLACE_WITH_RECIPIENT
      accountId: ""
    alertmanagerAuth:
      existingSecret: ""
      tokenKey: token
    webhook:
      path: /mosaic/alertmanager
      maxBodyBytes: 1048576
      existingSecret: ""
      tokenKey: token
```

Apply it together with the installation's existing values:

```bash
helm upgrade --install mosaic ./helm/mosaic-stack \
  --namespace mosaic \
  --values /secure/path/existing-values.yaml \
  --values /secure/path/alert-automation-values.yaml

kubectl -n mosaic rollout status deployment/openclaw
kubectl -n mosaic logs deployment/openclaw -c gateway --since=10m
kubectl -n mosaic exec deployment/openclaw -c gateway -- \
  node /app/dist/index.js gateway call mosaic.alertAutomation.status --json
```

The status RPC requires `operator.read`. It exposes task identities, states,
timestamps and message IDs, without tokens or full alert bodies. The usual
Gateway operator authentication still applies.

`agentId` must already exist in OpenClaw's Agent configuration. Set `sessionKey`
to the exact conversation that the native channel uses for incoming questions;
an invented session key would not associate the report with the user's real
conversation. It must belong to the selected Agent. Use a verified session from
an actual inbound message. Channel-specific target and session formats are
owned by those channel plugins.

For example, native Slack may use the following configured destination:

```yaml
delivery:
  channel: slack
  target: channel:C_REPLACE_WITH_CHANNEL
  sessionKey: agent:default:slack:channel:c_replace_with_channel
```

Native Microsoft Teams can be selected with `channel: msteams`, its configured
target, account and verified incoming session. Changing a configuration string
does not demonstrate that a particular platform's application, permissions,
proactive-send route and inbound replies work; validate each real channel.

## Configuration reference

All Helm settings below are under `modules.alertAutomation`.

| Setting | Default | Behavior |
| --- | --- | --- |
| `enabled` | `false` | Installs and enables the native plugin |
| `sourceMode` | `poll` | `poll`, `webhook`, or `both` |
| `alertmanagerUrl` | empty | Uses `observability.alertmanagerUrl`; append any API base path |
| `matchLabels` | `{}` | Literal equality filter; empty accepts every alert from this source |
| `includeExisting` | `false` | First polling snapshot records active alerts without investigating them |
| `pollSeconds` | `30` | Poll/timer interval, 1–3600 seconds; no model call for an empty queue |
| `timeoutSeconds` | `900` | Native investigation wait, 30–3600 seconds |
| `maxPending` | `100` | Maximum pending investigations; over-capacity webhook intake is not acknowledged |
| `agentId` | `default` | Existing Agent that owns the investigation and recipient conversation |
| `stateDirectory` | `alert-automation` | One directory name below the Gateway state directory on its PVC |
| `messagePrefix` | `MOSAIC automated alert report` | Literal report prefix |
| `reportLanguage` | `English` | Language requested from the Agent |
| `investigationContext` | empty | Optional deployment facts; does not prescribe tool sequence or research |
| `redactValues` | `[]` | Additional exact private identifiers replaced consistently in publication |
| `delivery.channel` | empty | Required native channel plugin ID |
| `delivery.target` | empty | Required fixed native outbound target |
| `delivery.sessionKey` | empty | Required actual recipient conversation, belonging to `agentId` |
| `delivery.accountId` | empty | Optional channel account |
| `alertmanagerAuth.existingSecret` | empty | Optional Kubernetes Secret containing the Alertmanager bearer token |
| `alertmanagerAuth.tokenKey` | `token` | Secret key loaded as `MOSAIC_ALERTMANAGER_TOKEN` |
| `webhook.path` | `/mosaic/alertmanager` | Exact Gateway HTTP receiver path |
| `webhook.maxBodyBytes` | `1048576` | Maximum JSON payload bytes, 1024–10485760 |
| `webhook.existingSecret` | empty | Required for `webhook`/`both`; dedicated bearer token, at least 24 characters |
| `webhook.tokenKey` | `token` | Secret key loaded as `MOSAIC_ALERT_WEBHOOK_TOKEN` |

The chart enables `hooks.allowConversationAccess` and `allowPromptInjection`
for this plugin because restoring the report is its explicit function. It also
configures the existing MOSAIC UI URL and machine-token reference for alert-card
import when the UI module is enabled. The plugin can run in standalone OpenClaw
without a MOSAIC UI by omitting `mosaicUrl` from its plugin configuration.

The plugin manifest accepts the runtime settings above except Helm's `enabled`
and Secret-reference structures. It additionally accepts `mosaicUrl` and the
environment-variable names `alertmanagerTokenEnv` and `webhook.tokenEnv`.
Secret values belong in environment/Secret injection, never `SKILL.md`, alert
annotations, a Helm ConfigMap or a checked-in values file.

## Webhook intake

Select `sourceMode: webhook` or `both`, create the dedicated Secret through your
approved credential workflow, and make the Gateway receiver reachable from
Alertmanager. Use TLS for a receiver outside a trusted private network. The
plugin uses its own bearer authentication for this exact route; it does not
accept query-string credentials or disable Gateway authentication elsewhere.

Add a receiver and a matching route to the existing Alertmanager configuration.
This is the receiver fragment; retain the installation's other receivers and
routes:

```yaml
receivers:
  - name: mosaic-investigation
    webhook_configs:
      - url: https://mosaic.example.com/mosaic/alertmanager
        send_resolved: true
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/mosaic-webhook-token
```

Alertmanager receives the token through its own mounted Secret. Both sides use
the same value. A successful HTTP 202 acknowledges a durable queue insertion,
not completion of an investigation or human receipt of a report. Authentication,
JSON/body limits and full-batch intake are enforced before acknowledgement.
Repeated deliveries share the same incident key. `both` mode can reconcile
source state through polling while using webhook events for prompt intake.

## Task state, report integrity and shutdown

The queue uses fingerprint **and** alert start time, matching the legacy worker.
An alert firing again later is a new occurrence. Polling silence/inhibition does
not imply resolution. Webhook `resolved` events and complete polling snapshots
record source recovery. The current implementation runs one investigation at a
time in the single Gateway Deployment and uses its existing Recreate/PVC model.

| State | Meaning after restart |
| --- | --- |
| `ignored_existing` | Recorded baseline; not automatically investigated |
| `queued` | May start; a failed pre-investigation UI import can be retried |
| `investigating` | Reconcile native history and mark `needs_attention`; do not start a duplicate run |
| `ready` | Complete report persisted; may begin publication |
| `sending` | Mark `delivery_unknown`; do not blindly repeat a possible external side effect |
| `sent` | All report parts have native platform message IDs; no restart resend |
| `resolved_before_start` | Source recovered while queued |
| `needs_attention` | Investigation/validation failure retained for inspection |
| `delivery_unknown` | Interrupted, partial or unconfirmed send; reconcile receipts before any replay |

Each incident retains the original alert, complete native goal, run ID,
completion status, original history, every actual tool call/result, unmodified
model report, published report, hashes, per-part send intentions/receipts,
context binding and failures. Publication changes private identifiers only;
it does not correct model facts or silently shorten the report. Large reports
are split into exact UTF-8 text chunks; joining all ordered parts reproduces
the complete published report. Each part's size/hash and all returned message
IDs are recorded. An unknown/partial send is not automatically retried.

Before publication, the plugin binds the complete report to the fixed recipient
session in SQLite. On every later turn in that session, its native prompt hook
restores the full bound report. An explicitly quoted incident/Run ID selects
that stored report; an ordinary question uses the latest report for that
conversation. The hook treats report contents as evidence, not executable
instructions. Other conversations receive no report context. This survives a
Gateway restart without creating a synthetic acknowledgement turn or relying
on a transcript-only delivery mirror. Hash validation rejects changed report
files. Native child-thread conversations inherit their configured parent
conversation's report at a session-key boundary; unrelated peers do not.
Context-use records preserve the run/session/report association.

Stopping the service cancels polling and forbids any subsequent investigation
or send. An already-running native Agent may finish independently; its persisted
interrupted task is reconciled on restart. The plugin never grants Edit/Auto
permissions. Investigation session names use the existing automation guard,
which keeps their tools in View even if interactive conversations support edits.

## Migrate a deployment-host worker

Keep the dated legacy worker and its complete evidence. Do not run the old
worker and the new plugin against the same incidents during cutover.

1. Inspect the legacy status and reconcile any active investigation or uncertain
   delivery. Capture the full status, source/filter, destination and session.
2. Stop the legacy `mosaic-alert-worker.service`. Retain its state directory and
   credential files in their existing private location. Its dedicated UI-forward
   service can be stopped after the native plugin is healthy.
3. Use Python's SQLite backup API to take a consistent database copy, then copy
   it and the complete incident directory into the plugin's PVC directory.
   The native plugin retains the legacy `meta`, `incidents` and `events` schema
   and adds its own `report_contexts` table. Copy files with the Gateway UID and
   private permissions. Do not copy machine tokens into the PVC evidence.
4. Preserve the existing source filter and fixed conversation during migration.
   Enable the plugin through Helm; verify the complete migrated ledger and that
   already-sent IDs were not investigated or published again.
5. Inject one isolated test occurrence, observe native Agent tools and complete
   delivery, then test an actual unquoted user follow-up and a Gateway restart.
   Platform send success and independent human receipt are separate checks.

Do not automatically replay old `needs_attention` or `delivery_unknown` rows.
The legacy worker's staged experiment remains available in the
[deployment-host worker guide](background_alert_investigation.md).

## Verification

The focused automated suite exercises native service lifecycle and HTTP intake,
generic channel/Agent configuration, actual legacy Python-database compatibility,
persistent deduplication, full report/context integrity over multiple turns and
restart, partial/unknown delivery handling, exact Unicode chunks, and credential
redirect isolation:

```bash
node --test helm/mosaic-stack/tests/alert-automation.test.mjs
helm lint helm/mosaic-stack
```

The native adapter tests use controlled fixtures. They do not establish live
Teams/Slack/Feishu platform authorization or receipt. Record each real-platform
verification separately, including its actual Run ID and returned message IDs.

References: [OpenClaw plugin services](https://docs.openclaw.ai/plugins/sdk-overview/infrastructure),
[OpenClaw 2026.6.10 plugin contracts](https://github.com/openclaw/openclaw/blob/v2026.6.10/src/plugins/types.ts),
[Alertmanager webhook configuration](https://prometheus.io/docs/alerting/latest/configuration/#webhook_config).
