<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Isolated Slack DM bridge

This optional service delivers completed incident reports to Slack DMs and routes replies to the MOSAIC headless API. Approved channels can opt in to mention-triggered private investigations. Slack Bot and App tokens belong to this process, outside the OpenClaw runtime and its execution sandboxes. Use one Socket Mode consumer per Slack App. Use a separate App for a second consumer.

```text
Existing investigation / trusted report publisher
                    |
                    | POST /incidents (complete report, incident ID, approved user ID)
                    v
               Slack DM bridge ---- Bot API ----> one incident root + report thread
                    ^                                      |
                    | Socket Mode message.im               | human replies in thread
                    +--------------------------------------+
                    |
                    | fixed View session + complete report + current question
                    v
            MOSAIC authenticated headless API
                    |
            configured Agent, tools and Research Agent
                    |
                    +---- completed answer ----> same Slack thread
```

The bridge does not ingest Alertmanager alerts, run an independent investigation loop, or install tools. Investigation remains in MOSAIC. The report publication endpoint is the integration boundary for an existing publisher. In particular, [alert automation PR #89](https://github.com/NVIDIA/AI-Factory-Operations-Agent/pull/89) owns alert intake and investigation; its native channel sender does **not** automatically call this endpoint. A publisher adapter must hand its complete final report to the endpoint. This bridge can be reviewed and deployed on `main` independently of that PR. It does not include or claim a tested direct #89 adapter.

## Prerequisites and boundaries

- Node.js **24.11.1 or later in the Node 24 line**, or another supported release providing built-in `node:sqlite`, `fetch`, and `WebSocket`. No npm packages are installed.
- A running MOSAIC UI/headless service, its machine token, and the main chart's automation guard. The bridge's deterministic `mosaic-automation-alert-slack-…` session names are permanently View mode in that guard. The HTTP request also explicitly selects `accessMode: view`.
- An approved Slack Bot App installed in **one workspace**, an App token with `connections:write`, and explicit user allowlists. The bridge accepts ordinary one-to-one DM text events, including internal Grid DMs whose organization context matches the Bot Token's authenticated enterprise. The optional channel entry point accepts explicit app mentions in approved workspace-local Slack channels.
- Connectivity from the bridge to `slack.com`, Slack's `wss://*.slack.com` Socket Mode hosts, the configured MOSAIC service, and an optional credential broker. No public Slack callback is needed. Restrict the publication service to trusted publishers with network policy; add TLS for traffic crossing an untrusted network.
- A private persistent volume used only by this bridge. It contains full incident reports, incoming questions, recovery prompts, model answers, deduplication records and delivery receipts. These are conversation state, not application logs. Apply the same access controls, encryption, backup and retention policy as for the associated operational evidence.
- Approved users must be authorized to access **all data exposed by the configured MOSAIC tools**. View mode prevents infrastructure changes; it is not a per-user data access policy. This bridge does not add source-specific authorization or make an existing deployment compliant with an organization's policies automatically.

## 1. Create and install the Slack App

1. Open [Slack App management](https://api.slack.com/apps), choose **Create New App → From a manifest**, select the workspace, and paste [slack-app-manifest.json](slack-app-manifest.json).
2. Request installation/administrator approval through your organization's normal process. Install the App in the selected workspace.
3. Under **OAuth & Permissions**, obtain the **Bot User OAuth Token** (`xoxb-…`). Do not use a user token or a browser session token.
4. Under **Basic Information → App-Level Tokens**, generate an App token (`xapp-…`) with **`connections:write`**. **Socket Mode** must be enabled.
5. Under **App Home**, confirm **Messages Tab** is enabled and allows users to send messages. The manifest enables this.
6. Record the workspace ID (`T…`), App ID (`A…`), bot user ID (`U…`), and the approved humans' user IDs (`U…` or `W…`). For a human, Slack profile → More → Copy member ID. The bot identity can be verified with `auth.test`; the bridge checks it against the configured values at startup.

The manifest requests exactly these permissions:

| Token / setting | Scope / event | Used for |
|---|---|---|
| Bot | `chat:write` | Send incident roots, report chunks and replies |
| Bot | `im:write` | Open and verify the recipient's one-to-one DM through `conversations.open(return_im=true)` |
| Bot | `im:history` | Receive `message.im` events |
| App | `connections:write` | Obtain Socket Mode connection URLs |
| Bot event | `message.im` | Receive ordinary DM messages and thread replies |

No user token, user directory search, channel history or group DM permission is requested. Token rotation in the example manifest is disabled; if the organization requires rotating OAuth tokens, its credential provider must refresh them and return the current token on demand. This utility does not implement Slack OAuth refresh-token exchange.

## 2. Configure the bridge and credentials

Copy [config.example.json](config.example.json) to a private working directory as `bridge.json`. Replace all identity placeholders and set `mosaicUrl` to the base URL of the intended MOSAIC service. `allowedUserIds` is a fixed snapshot: adding someone in Slack does not grant them access. Edit this list and restart the bridge to change access.

The example deployment uses a credential bundle mounted **only into the bridge**, never into OpenClaw. Create the following JSON locally using a password manager or editor; do not put its contents in shell arguments, Git, chat, logs, or a ConfigMap:

```json
{
  "botToken": "REPLACE_WITH_SLACK_BOT_TOKEN",
  "appToken": "REPLACE_WITH_SLACK_APP_TOKEN",
  "mosaicToken": "REPLACE_WITH_MOSAIC_MACHINE_TOKEN",
  "publishToken": "REPLACE_WITH_RANDOM_SECRET_AT_LEAST_32_CHARACTERS"
}
```

Restrict the file with `chmod 600`. The bridge rereads it for every credential use, follows projected Kubernetes Secret symlinks, and rejects files readable by others. The Kubernetes example uses group-readable `0440` with a dedicated process group. Updating the Secret's projected file does not require restarting the bridge; the App token is used on the next Socket Mode connection, whereas Bot/API tokens are read on each call.

For an approved secret store that prohibits persistent transport tokens in files, omit `credentialsFile` and set:

```json
{
  "credentialSocket": "/run/credential-broker/credentials.sock"
}
```

The local broker contract is:

```text
GET /v1/credentials/botToken
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: no-store

{"value":"CURRENT_BOT_TOKEN"}
```

The other allowed names used by the bridge are `appToken`, `mosaicToken`, and `publishToken`. The bridge requests one name at a time, with a 5-second timeout and 16-KiB response limit, and retains it only for the outbound request. The Unix socket and its parent directory must be accessible only to the broker and bridge. The broker is deployment-provided; no Vault implementation or organization-specific authentication configuration is included. Mount that socket into the bridge instead of the credential Secret in the deployment example. Never mount the socket into an agent execution environment.

Both modes are supported, but exactly one must be configured. The repository does not include an actual credential file. Slack credentials never go into a model prompt or the MOSAIC HTTP request.

### Optional channel mentions

In **OAuth & Permissions**, add `app_mentions:read` and the conversation metadata scope for the channels you will use. Add `channels:read` for public channels or `groups:read` for private channels. Under **Event Subscriptions → Subscribe to bot events**, add `app_mention`. Reinstall the App if Slack prompts for approval of the additional scopes. Invite the App into each approved channel.

Set the reviewed channel-to-user mappings in `bridge.json`:

```json
{
  "allowedChannels": {
    "C12345678": ["U12345678", "U23456789"]
  }
}
```

Omit the field or use an empty object for DM-only operation. Each entry is an explicit snapshot. Inviting the App or adding a new member in Slack does not change the bridge allowlist. Edit the configuration and restart the bridge to update access.

An authorized mention creates a fixed acknowledgment in the original Slack thread and opens a private thread for the requester. MOSAIC sees the current question with the Bot mention removed. The answer and subsequent follow-ups use that private View session. Channel recipients receive only the fixed acknowledgment. Each explicit channel mention starts a separate private conversation. Ordinary channel messages, even replies in a channel thread, are ignored. The bridge requires current App membership and same-workspace, non-shared channel metadata. Channel access grants a private thread for that request. Standalone DMs and incident publications still use `allowedUserIds`.

## 3. Deploy alongside MOSAIC

The example uses a separate Pod, a single replica, a persistent volume and `Recreate` updates. It does not give the bridge a Kubernetes API token or any cluster role. Adjust the image mirror/digest, resources and storage class to your environment before applying.

Run from the repository root. Replace the namespace and the two private file paths:

```bash
kubectl -n aifoa create configmap mosaic-slack-bridge-code \
  --from-file=utils/slack_dm_bridge/bridge.mjs \
  --from-file=utils/slack_dm_bridge/store.mjs \
  --from-file=utils/slack_dm_bridge/transport.mjs \
  --dry-run=client -o yaml | kubectl -n aifoa apply -f -

kubectl -n aifoa create configmap mosaic-slack-bridge-config \
  --from-file=bridge.json=/PRIVATE/PATH/bridge.json \
  --dry-run=client -o yaml | kubectl -n aifoa apply -f -

kubectl -n aifoa create secret generic mosaic-slack-bridge-credentials \
  --from-file=bridge.json=/PRIVATE/PATH/credentials.json \
  --dry-run=client -o yaml | kubectl -n aifoa apply -f -

kubectl -n aifoa apply -f utils/slack_dm_bridge/deployment.yaml
kubectl -n aifoa rollout status deployment/mosaic-slack-bridge
```

If migrating the **same Slack App** from the native channel, first set `openclaw.slack.enabled=false` in the existing Helm release's retained site configuration and apply that configuration. Keep Feishu, Teams and other site values intact. If using a different Slack App, the native channel can remain enabled. Switching back requires stopping the bridge before enabling the native consumer for that same App; their conversation stores are not interchangeable.

After code or allowlist ConfigMap updates, restart the bridge explicitly:

```bash
kubectl -n aifoa rollout restart deployment/mosaic-slack-bridge
```

For a local process, use absolute paths, bind the publication API to `127.0.0.1`, and run:

```bash
node utils/slack_dm_bridge/bridge.mjs /PRIVATE/PATH/bridge.json
```

## 4. Publish a complete incident report

The trusted publisher sends **one complete final report**, not a stream of partial chunks. The bridge creates a root message, saves its Slack timestamp, and publishes all report chunks under that root. It stores the full report for every later follow-up. A report can come from any existing investigation service; the publisher remains responsible for selecting an authorized recipient and for removing secrets from the report.

Create `incident.json`:

```json
{
  "incidentId": "gpu-xid-95-example-001",
  "userId": "U12345678",
  "title": "GPU Xid 95 investigation",
  "report": "Full final report, including evidence times, collected observations, research sources, uncertainties and next steps."
}
```

Create a private `publisher.headers` file containing `Authorization: Bearer YOUR_PUBLISH_TOKEN` (mode `0600`). Only this publication token is needed by the publisher; it does not need Slack tokens or the MOSAIC machine token. Port-forward for a local check:

```bash
kubectl -n aifoa port-forward service/mosaic-slack-bridge 8790:8790
```

In another terminal:

```bash
curl --fail-with-body http://127.0.0.1:8790/incidents \
  --header @/PRIVATE/PATH/publisher.headers \
  --header 'Content-Type: application/json' \
  --data-binary @incident.json
```

The response is `202` with `id`, `state`, and `duplicate`. This means the request is durable, **not** that Slack delivery has completed. Poll the returned ID:

```bash
curl --fail-with-body http://127.0.0.1:8790/incidents/RETURNED_64_CHARACTER_ID \
  --header @/PRIVATE/PATH/publisher.headers
```

The status includes the DM channel, root `threadTs`, `reportSha256`, confirmed report parts and total report parts. Success is `state=done` with every part confirmed. It does not return report contents. Repeating the same `(workspace, recipient, incidentId, title, report)` returns the original record; changing the title/report under that identity returns `409`. Use a new incident ID for a new report revision in this first version.

Limits are 128 characters for incident IDs, 160 Unicode characters for titles, 192 KiB UTF-8 per report, and 256 KiB for the HTTP body. Oversized reports are rejected; they are not silently truncated. Slack report parts contain at most 2,800 Unicode characters, and concatenating them exactly reconstructs the input report. Plain-text Block Kit sections preserve content and prevent embedded `<!channel>` or `<@USER>` syntax from notifying other users.

## 5. Converse and verify

1. Send a normal DM to the App as an allowlisted user. The bridge answers in a thread rooted at that message. Reply **inside that thread** to continue the same conversation. A new root-level DM starts a separate conversation.
2. Publish the example report and wait for `state=done`.
3. Reply in the report's thread: "Collect the related logs again and consult the Research Agent. Separate observed evidence from document guidance." The complete report is included in the corresponding View-only headless conversation. Actual collection and research require those tools to be configured in MOSAIC.
4. Publish a second incident, then ask a follow-up in each thread. Each must retain its own report and session. An unknown thread is ignored instead of being assigned to the latest incident.
5. Restart the bridge with its persistent volume intact and repeat a follow-up in the first thread. Verify that it retains that report's context.
6. Try a non-allowlisted user and a different workspace/channel. They must not create Agent runs. Also verify that a request to switch to Edit cannot change the automation session's View restriction.
7. If channel mentions are enabled, mention the Bot as an approved user in the approved channel. Verify a fixed acknowledgment in the original channel thread and an answer in a separate DM thread. Continue the conversation in that DM thread. Send an ordinary channel message and check that it does not queue a request.

`GET /healthz` reports whether Socket Mode is connected and aggregate queue states. It returns no message or credential contents. Readiness indicates a live socket, not successful completion of every pending investigation. Check the incident status and `send_unknown`/`failed` counters as well.

## Persistence and failure semantics

| Condition | Behavior |
|---|---|
| Slack envelope received | Validate workspace, App, sender and message type. Commit the inbox transaction before ACK. Perform no network or model call in the ACK callback. |
| Event redelivery / duplicate message timestamp | Ignore after durable deduplication, including after process restart |
| Another user or unknown incident thread | Ignore; never borrow another user's report or select the latest incident heuristically |
| Allowed user removed from configuration | Queued work for that user is rejected after configuration reload/restart |
| Wrong recipient, Slack Connect, or unverified shared DM returned by Slack | Reject the job before calling MOSAIC or delivering content |
| Channel no longer allowlisted, unverified membership, or shared channel | Reject the channel-origin request before acknowledging publicly or invoking MOSAIC |
| Headless submission times out or process restarts | Read the original session history; do not resubmit an ambiguous Agent turn |
| Active run, stale answer or tool-call turn | Wait for the final answer matching the full durable prompt |
| No confirmed completion after 15 minutes | Send a bounded failure notice in the same thread; do not claim successful investigation or resubmit the request |
| Slack rate limit (`429`) | Persist `Retry-After`, then resume from the first unconfirmed chunk |
| Confirmed permanent Slack rejection | Mark `failed`; expose status for operator intervention |
| Network/server error or crash around message send | Mark `send_unknown`; stop that delivery rather than risk duplicates |
| Second writer on the same SQLite volume | Refuse startup through an exclusive database lock |
| Different workspace/App/bot/MOSAIC URL using existing state | Refuse startup; state is bound to that installation |
| Queue storage full or configured capacity reached | Refuse new admission; do not ACK work that could not be persisted |

Exactly-once external side effects cannot be guaranteed when a remote server accepts a request but its receipt is lost. For `send_unknown`, inspect the relevant Slack conversation and the private state before deciding to deliver a replacement report with a new incident ID. This version does not automatically reconcile unknown receipts, fetch missed historical messages, replay uncertain model submissions, or provide an administrative "retry everything" switch.

SQLite uses full synchronous commits and retains all records, including terminal jobs, to preserve deduplication. The default capacity is **10,000 total jobs** (maximum configuration: 100,000), not just pending jobs. Monitor disk usage and capacity; there is no automatic purge. Archive and retire an installation's state only after its retained threads are no longer needed. Removing the volume loses context, deduplication and receipt history; old threads are then ignored. Do not mount the state volume into OpenClaw or share it between independent bridge installations.

Application stdout logs only timestamps, fixed event names and opaque job IDs. Reports and question/answer bodies remain in private conversation storage and MOSAIC's own session store. Configure retention for both stores. No token-bearing raw HTTP errors or Socket Mode URLs are logged.

## Tests and evidence boundary

```bash
node --test utils/slack-dm-bridge.test.mjs
```

The automated suite uses temporary SQLite databases, local HTTP/Unix-socket servers, simulated Socket Mode frames, and Slack/MOSAIC protocol fixtures. It tests the complete report-to-thread-to-headless-to-thread path and restart recovery. It does **not** establish that an organization's real App is approved, that its secret broker is configured, or that its deployed Research Agent succeeds. Run the real-workspace checklist above and retain actual message IDs before claiming those results.

Public protocol references: [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/), [message.im](https://docs.slack.dev/reference/events/message.im/), [app_mention](https://docs.slack.dev/reference/events/app_mention/), [conversations.info](https://docs.slack.dev/reference/methods/conversations.info/), [conversations.open](https://docs.slack.dev/reference/methods/conversations.open/), [chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/).
