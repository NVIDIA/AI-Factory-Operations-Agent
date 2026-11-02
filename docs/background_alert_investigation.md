<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Background alert investigation and native Feishu delivery

`utils/mosaic-alert-worker.py` runs on the deployment host as a persistent user
service. It polls an existing Alertmanager, imports alerts into MOSAIC, and gives
the alert and investigation goal to the Agent through the headless API. The
Agent chooses its diagnostic tools, sequence, knowledge queries and conclusion
in its normal tool loop. The worker preserves the complete results and report,
then publishes through the configured OpenClaw native Feishu channel. An open
browser is not required.

The operator selects the Alertmanager source, an optional label filter, and the
destination conversation: an approved group or verified bot-to-user DM. In
Agent mode an empty `match_labels` object accepts all alerts from that source;
neither `mosaic_test` nor `background_validation` is required.
The default first poll records already-active alerts without investigating them.
New alerts are keyed by fingerprint **and** start time in a persistent SQLite
database. Restarting a completed worker does not send the same report again.

## Processing and permissions

```text
Existing Alertmanager, optional literal label filter
    -> persistent worker + SQLite incident ledger
    -> MOSAIC alert API
    -> one headless goal, View: native Agent investigation loop
       -> Agent chooses evidence, tools, order and follow-up queries
       -> Agent decides whether IRAOP is useful and builds its own question
    -> same read-only Agent session: complete report
    -> configured recipient Agent conversation: real full-report input
    -> verify complete input; external delivery disabled for this handoff
    -> separate fixed native CLI publisher
    -> OpenClaw Feishu plugin -> approved group or verified direct message

Every stage -> complete private requests, responses and evidence
```

### Agent-led and staged investigation

`investigation_mode: "agent"` is the default. The worker submits one investigation
goal and waits for the real native run to finish. There is no fixed container
list, mandatory research call, canned research question or predetermined
diagnosis. Optional `investigation_context` supplies deployment facts. The
staged-mode `collection_context`, `research_question` and `research_collections`
fields do not prescribe the Agent-mode workflow.

The Agent can discover knowledge collections through its installed tools and
choose to consult IRAOP when useful. Its actual calls, arguments, failures and
complete results are retained. A report explaining missing access or evidence
is still delivered, with the actual tool/error counts recorded separately;
delivery is not a claim that sufficient evidence was collected or the diagnosis
is correct. The worker does not fill gaps by invoking operator-selected tools.

`investigation_mode: "staged"` retains the earlier deterministic workflow for
reproducing the dated experiments: collection, a worker-issued IRAOP query, and
same-session synthesis. That mode requires a nonempty label filter and explicit
`research_collections`, and uses optional `collection_context`/`research_question`.
Original experiments, failed runs and complete reports remain historical
evidence; switching modes does not rewrite or replay them.

Every investigation uses
`agent:default:mosaic-automation-alert-<incident-id>`. This matches the existing
automation guard, which keeps the session read-only even if the installation
also supports interactive Edit/Auto sessions. The worker does not change access
mode or request cluster mutations.

Publication is an independent operator action. With `delivery.session_key`
configured, the worker first transfers the complete published report through a
normal Gateway `agent` turn in the configured recipient conversation. That
automatic receipt-only turn has external delivery disabled and the message tool
disabled. The worker waits for completion and reads `chat.history` with an
explicit text limit to verify the complete report in a real Agent input record.
It then calls a fixed `kubectl exec ... node /app/dist/index.js gateway call send
--params ...` argument array and marks the incident `sent` only after receiving a
platform message ID. The original report is published unchanged; the receiving
Agent's acknowledgement is not substituted for it.
Configurations without a session key retain the original
`message send --channel feishu` path for delivery-only compatibility.
The agent cannot choose the
executable, namespace, channel, recipient or shell command. The report is one
literal argument, and no shell is used. The gateway's existing application
Secret and native plugin perform delivery; the worker does not copy the Feishu
App Secret. The deployment-host account must already be authorized to invoke
this gateway CLI. This operator privilege is separate from the agent's View
permissions.

The HTTP `message` tool can be rejected by the View guard. Keep that guard;
do not enable Edit/Auto or relax tool policy to make a notification work.

## Prerequisites

| Input | Required access and purpose |
| --- | --- |
| Deployment host login | A dedicated, authorized account with Python 3.11+ and a user systemd manager |
| Existing MOSAIC deployment | Working headless API and the existing UI machine token |
| Alertmanager URL | Read access to `/api/v2/alerts`; optional bearer token supported through `ALERTMANAGER_BEARER_TOKEN` |
| Alert selection | Optional literal label filter; `{}` accepts all alerts from the configured source in Agent mode |
| Diagnostic tools | Existing registered targets and permitted read-only access to metrics, workloads and logs; the Agent chooses among tools it can actually use |
| IRAOP | Optional for Agent-led investigation; useful research requires working knowledge tools and approved documents. Staged mode requires it |
| Existing native Feishu channel | Published application, loaded plugin, authorized recipient conversation and working native send |
| Publisher Gateway device | Approved `operator.write` for native `send`; `operator.read` for history verification. This is deployment authorization, not an investigation access-mode change |
| Kubernetes context | The host account can port-forward the UI and invoke the selected gateway's native CLI |
| Persistent local state | Private writable disk under `~/.local/state/mosaic-alert-worker` |
| Service ownership | A customer administrator approves startup, maintenance, token rotation and the report's sharing scope |

Customer application creation, publication, organization approval, group
membership, corpus authorization and host credentials remain customer actions.
Installing MOSAIC alone supplies none of those approvals. Native Feishu uses an
App ID/App Secret; a custom-bot Webhook URL is a separate delivery credential.

### One-time publisher device authorization

An existing read-only CLI device may successfully read `chat.history` while a
new `send` connection fails with `scope upgrade pending approval` or Gateway
close code `1008`. Complete this deployment step before the live alert test.
From an already authorized Gateway administrator client, inspect the pending
request and approve the exact publisher device/scope request:

```bash
openclaw devices list --json
openclaw devices approve REVIEWED_REQUEST_ID --json
```

Check the actual device identity, `clientId=cli`, operator role and requested
scope. The publisher needs read/write access, not `operator.admin` or
`operator.pairing`. Keep the administrator's management identity separate where
possible. A read-only publisher cannot grant its own broader access through the
Gateway. On the Gateway host, an authorized local owner can use OpenClaw's local
pairing recovery; do not disable device authentication or hand-edit the paired
device records. Some CLI versions can replace a pending request while opening
the management connection, so re-check the request identity and scopes after
an `unknown requestId` result rather than approving an unchecked latest request.

Approval is retained with the device identity in the persistent OpenClaw state.
Ordinary alerts do not require repeated approval. Replacing the device identity,
discarding that state or requesting broader scopes can require a new deployment
approval. The investigation remains in View mode. See
[OpenClaw device management](https://docs.openclaw.ai/cli/devices) and
[operator scopes](https://docs.openclaw.ai/gateway/operator-scopes).

## Install the persistent services

Run on the Linux deployment host from a checkout containing this utility. Use
the actual site values, and an already functional native channel:

```bash
export KUBE_CONTEXT=kind-example
export MOSAIC_NAMESPACE=mosaic
export MOSAIC_UI_AUTH_SECRET=mosaic-ui-auth
export MOSAIC_KUBECTL="$(command -v kubectl)"
export ALERTMANAGER_URL=https://alerts.example.com
export FEISHU_CHAT_ID=oc_REPLACE_WITH_APPROVED_CHAT
export FEISHU_SESSION_KEY=agent:default:feishu:direct:ou_REPLACE_WITH_VERIFIED_USER

install -d -m 0700 "$HOME/.local/share/mosaic-alert-worker"
install -d -m 0700 "$HOME/.config/mosaic-alert-worker"
install -d -m 0700 "$HOME/.local/state/mosaic-alert-worker"
install -d -m 0700 "$HOME/.config/systemd/user"
install -m 0600 utils/mosaic-alert-worker.py \
  "$HOME/.local/share/mosaic-alert-worker/mosaic-alert-worker.py"
install -m 0600 docs/examples/alert-investigator/mosaic-alert-worker.service \
  "$HOME/.config/systemd/user/mosaic-alert-worker.service"
install -m 0600 docs/examples/alert-investigator/mosaic-alert-ui-forward.service \
  "$HOME/.config/systemd/user/mosaic-alert-ui-forward.service"
```

Create the site configuration and privately read the existing UI machine token.
The token is written to a `0600` environment file, never printed:

```bash
python3 - <<'PY'
import base64, json, os, subprocess
from pathlib import Path
os.umask(0o077)
home = Path.home()
directory = home / ".config/mosaic-alert-worker"
config = json.loads(Path("docs/examples/alert-investigator/config.example.json").read_text())
config.update(
    alertmanager_url=os.environ["ALERTMANAGER_URL"],
    state_dir=str(home / ".local/state/mosaic-alert-worker"),
)
config["delivery"].update(
    kubectl=os.environ["MOSAIC_KUBECTL"],
    context=os.environ["KUBE_CONTEXT"],
    namespace=os.environ["MOSAIC_NAMESPACE"],
    target="chat:" + os.environ["FEISHU_CHAT_ID"],
    session_key=os.environ["FEISHU_SESSION_KEY"],
)
secret = json.loads(subprocess.check_output([
    os.environ["MOSAIC_KUBECTL"], "--context", os.environ["KUBE_CONTEXT"],
    "-n", os.environ["MOSAIC_NAMESPACE"], "get", "secret",
    os.environ["MOSAIC_UI_AUTH_SECRET"], "-o", "json",
]))
token = base64.b64decode(secret["data"]["machineToken"]).decode()
if not token or "\n" in token or "\r" in token:
    raise ValueError("Invalid UI machine token")
(directory / "config.json").write_text(json.dumps(config, indent=2) + "\n")
(directory / "credentials.env").write_text("MOSAIC_UI_MACHINE_TOKEN=" + json.dumps(token) + "\n")
(directory / "deployment.env").write_text(
    "KUBECTL=" + json.dumps(os.environ["MOSAIC_KUBECTL"]) + "\n"
    + "KUBE_CONTEXT=" + json.dumps(os.environ["KUBE_CONTEXT"]) + "\n"
    + "KUBE_NAMESPACE=" + json.dumps(os.environ["MOSAIC_NAMESPACE"]) + "\n"
)
for name in ("config.json", "credentials.env", "deployment.env"):
    (directory / name).chmod(0o600)
PY
```

The complete configuration shape is in
[config.example.json](examples/alert-investigator/config.example.json).
`match_labels` contains literal equality checks, not regular expressions. The
Agent-mode example uses `{}` for all alerts from the configured Alertmanager.
Use a site label such as `{"cluster": "registered-cluster"}` when selecting a
subset; test-only labels are not a software requirement. The first poll records
already-active alerts as a baseline. Set `include_existing=true` when
intentionally investigating existing alerts as well.

When changing the alert source or broadening the filter, choose the baseline
behavior deliberately. The existing ledger's initialization marker is already
set; changing a filter does not automatically rebaseline. A new separately
named state directory starts a fresh baseline while preserving the original
ledger and evidence in place. Do not clear or edit old records to manufacture a
new investigation.

### Deliver reports to a direct message

The fixed `chat:oc_...` target can identify either a group or the existing
conversation between the application bot and an authorized user. An `oc_...`
prefix alone does not prove which kind of conversation it is. Set the matching
`delivery.session_key` to support ordinary follow-up questions about reports;
changing only the destination does not establish conversation context.

1. Have the intended recipient send a real direct message to the published
   application bot and verify that the native channel can reply. Keep the
   recipient in the configured inbound user allowlist.
2. Read that exact message using `GET /open-apis/im/v1/messages/{message_id}`.
   Match its sender to the intended recipient's known `open_id` and record its
   `chat_id`. Verify the conversation using
   `GET /open-apis/im/v1/chats/{chat_id}`; `chat_mode` must be `p2p`.
3. Test the installed native publisher against `chat:<verified-chat-id>`. Read
   the returned message ID from the platform and check the recipient, complete
   report and Run ID. A successful CLI exit is not independent receipt evidence.
4. Obtain the actual native inbound session key for that recipient, such as
   `agent:default:feishu:direct:ou_VERIFIED_USER`. For a simple group session use
   `agent:default:feishu:group:oc_VERIFIED_GROUP` with the same group ID as the
   delivery target. When no incident is in progress, back up the private
   configuration and set both `delivery.target` and `delivery.session_key`.
   Validate the configuration, restart `mosaic-alert-worker.service`, and check
   that the service is active and the existing ledger is unchanged.
5. Create a new isolated test alert after the service is running. Verify actual
   collection, IRAOP sources, the model's full report and the new native message
   in the intended direct-message conversation.

The inbound `dmPolicy`/`allowFrom` settings control who can talk to the agent;
they do not select the worker's outbound report recipient. This utility has one
fixed delivery target. Changing that target changes subsequent reports from the
group destination to the configured direct message; it does not add a second
destination or replay completed incidents.

With `delivery.session_key` set, ask an ordinary question in the same direct
message after receiving the report; no copying, special marker or quoted reply
is required. The worker's automation session remains separate, while the
complete published report is automatically handed into the real native Agent
conversation before delivery. Feishu's **Reply** action is also useful to identify a particular
report when several incidents have arrived. Retain the incoming message ID,
real report input record, native model response and outgoing message ID to verify
the complete conversational loop.

The Gateway receives separate deterministic idempotency keys for context handoff
and publication. A `delivery-mirror` or `gateway-injected` assistant record is
transcript-only in the tested OpenClaw version; finding it in display history
does not prove that a future model turn can use the report. The worker therefore
requires a real input record containing the full report. History display defaults
to 8,000 characters, so verification explicitly requests enough characters for
the complete handoff; it never accepts a truncated prefix as proof.

The worker keeps the platform receipt in `native-delivery.gateway-receipt.json`.
If context handoff is incomplete or sending is ambiguous, the incident becomes
`delivery_unknown` and is not blindly tried again. The full handoff request,
acknowledgement, history response, receipt and error remain available for
reconciliation. The receipt-only Agent turn runs automatically in the service;
no manual context backfill, `chat.inject` call or direct transcript-file editing
is used. Its output does not alter the report's facts.

### Select the Agent through configuration

`delivery.target` selects the Feishu recipient conversation.
`delivery.session_key` selects the OpenClaw conversation and includes its Agent
ID. The native incoming Feishu binding must select that same Agent/session.
Display names do not select an Agent. Configure the intended Agent with its own
workspace and permissions before binding users to it.

For example, an existing `ops` Agent can receive a verified user's direct
messages through the native OpenClaw configuration:

```json
{
  "bindings": [{
    "agentId": "ops",
    "match": {
      "channel": "feishu",
      "peer": {"kind": "direct", "id": "ou_VERIFIED_USER"}
    }
  }]
}
```

After verifying a real incoming message reaches that Agent, use the actual
conversation key and verified p2p chat ID in the worker configuration:

```json
{
  "delivery": {
    "channel": "feishu",
    "target": "chat:oc_VERIFIED_P2P_CHAT",
    "session_key": "agent:ops:feishu:direct:ou_VERIFIED_USER"
  }
}
```

These are partial configuration examples; retain the other required deployment
fields. Native binding configuration must be retained in the deployment's
persistent OpenClaw configuration, not changed only inside a running Pod.
Custom session scopes can change the native key; inspect the actual incoming
route rather than guessing it. The current worker accepts simple native
`direct:ou_...` and `group:oc_...` conversation keys. See
[OpenClaw channel routing](https://docs.openclaw.ai/channels/channel-routing).

In staged mode, optional `collection_context` provides trusted site-specific collection
scope, such as registered cluster aliases and the intended workload/log fields.
An optional `research_question` controls the documentation-only question. It
should ask for a general procedure and filename/page references, while keeping
incident measurements in the diagnostic session. `redact_values` can list site
identifiers to remove from published text. The publisher also replaces IPv4
endpoints, GPU UUIDs and email addresses consistently; original responses and
the original model report remain in the private state directory. The worker
does not shorten reports or apply factual corrections to model output.

Validate and start:

```bash
python3 "$HOME/.local/share/mosaic-alert-worker/mosaic-alert-worker.py" \
  --config "$HOME/.config/mosaic-alert-worker/config.json" --status

systemd-analyze --user verify \
  "$HOME/.config/systemd/user/mosaic-alert-ui-forward.service" \
  "$HOME/.config/systemd/user/mosaic-alert-worker.service"
systemctl --user daemon-reload
systemctl --user enable --now \
  mosaic-alert-ui-forward.service mosaic-alert-worker.service
systemctl --user status mosaic-alert-worker.service
loginctl show-user "$USER" -p Linger
```

For operation after logout and reboot, the user manager needs lingering. If
`Linger=no`, have the host administrator enable it for this service account:

```bash
sudo loginctl enable-linger "$USER"
```

The UI connection binds only `127.0.0.1:13300`; it does not expose a new public
endpoint. The worker uses the existing deployment and preserves its Helm
release. When UI credentials rotate, refresh the private environment file and
restart the worker under the site's maintenance process.

## Observe every stage

```bash
journalctl --user -u mosaic-alert-worker.service -f

python3 "$HOME/.local/share/mosaic-alert-worker/mosaic-alert-worker.py" \
  --config "$HOME/.config/mosaic-alert-worker/config.json" --status
```

The journal prints incident IDs, phases and error types, excluding credentials
and report bodies. The status command returns all stored incidents, including
their source fingerprint/start time, automation session key, phase, timestamps,
delivery message ID, error type and source-resolution state. Treat this output
as internal because it includes the original alert JSON.

For one incident, inspect its complete private files under
`~/.local/state/mosaic-alert-worker/incidents/<incident-id>/`:

| File or prefix | Evidence |
| --- | --- |
| `alert.json` | Complete selected Alertmanager alert |
| `mosaic-import.*` and `mosaic-import-confirmed.json` | MOSAIC upsert request, response and acknowledgement |
| `investigation.*` | Single Agent-mode goal and complete headless response |
| `investigation-history.*` | Complete native Agent history, including its chosen tool sequence |
| `investigation-tool-activity.json` | Every original tool-request record and result, including failures and source record numbers |
| `investigation-execution.json` | Mode, actual result/error counts, ordered tool names and absence of worker-issued research |
| `collection.*` | Staged-mode first headless request and response |
| `collection-history.*` | Native Gateway history with actual diagnostic calls/results |
| `collection-tool-results.json` | Every native tool result; staged mode requires at least one successful diagnostic result, Agent mode records actual results including zero-tool or failed-evidence reports |
| `research.*` | Actual `iraop_query` request and complete response |
| `research-sources.json` | All returned source references |
| `synthesis.*` | Same-session synthesis request and complete response |
| `final-history.*` | Final native conversation history |
| `model-report.txt` | Complete, fact-uncorrected model report |
| `published-report.txt` | Complete published text with identifier redactions and report metadata |
| `report-integrity.json` | Original/published sizes, hashes and explicit no-truncation/no-factual-edit flags |
| `native-delivery.intent.json` | Fixed target/channel and complete report hash/length |
| `native-delivery.stdout.log` and `.stderr.log` | Complete native CLI output |
| `native-delivery.context-handoff.request.json` and `.response.json` | Complete automatic receiving-Agent input and its receipt-only turn; external delivery and message tool disabled |
| `native-delivery.gateway-receipt.json` | Confirmed platform receipt after successful real-context verification |
| `native-delivery.context-history.stdout.log` and `.stderr.log` | Complete native history readback for the configured Agent conversation |
| `native-delivery.context-verification.json` | Full report verified inside the actual Agent input record; context message ID, handoff run ID and report hash |
| `native-receipt.json` | Parsed message ID and original structured send result |
| `mosaic-resolution.*` | Removal of the worker-owned MOSAIC card after source resolution |
| `failure.json` | Current failure phase and error, without the UI token |

Repeated HTTP attempts receive numbered filenames; earlier responses and failed
attempts are retained. The SQLite `events` table records every phase transition.
Source resolution removes only a card successfully imported by this worker;
silencing or inhibition is not treated as source resolution. Conversation
history and report evidence remain available after card cleanup.

The headless API can return `success=true` while an intermediate assistant
message has been emitted and diagnostic tools are still active. The worker
keeps the original response and waits for inactive native history after the
exact submitted prompt; it does not submit another prompt to finish the first
one. `collection-completion-history*` and `synthesis-completion-history*` retain
every observation. The corresponding `*-completion.json` records the final
assistant answer and the completion basis. Length-limited, aborted or failed
model generations do not qualify as a complete report.

IRAOP transports can wrap results in MCP text or `structuredContent`. The worker
accepts those actual envelopes and checks for an answer with a document name
(`source_file`, `filename`, `document_name` or `document`) and a positive
`page_number` or `page`. It retains the original response and every source row.

## Delivery and recovery states

| State | Meaning and recovery behavior |
| --- | --- |
| `ignored_existing` | Present in the initial baseline; intentionally not investigated |
| `queued` | Newly selected alert; idempotent MOSAIC import can retry before any model run starts |
| `investigating` | Agent mode: one goal submitted; the native Agent selects and executes its investigation steps |
| `collecting` | Read-only diagnostic session started; actual native tool evidence is required |
| `researching` | Actual IRAOP request; answer and a usable filename/positive-page reference are required |
| `synthesizing` | Combining real observations and documentation in the same read-only session |
| `ready` | Complete report saved; safe to begin its first publication |
| `sending` | External side effect may be in flight; recorded before invoking the native CLI |
| `sent` | Native delivery returned a message ID; when `session_key` is configured, the complete report was also verified in that conversation; no automatic resend on restart |
| `resolved_before_start` | Source alert disappeared before a queued investigation began |
| `needs_attention` | Investigation failed or was interrupted; preserve history and inspect it before starting another run |
| `delivery_unknown` | Delivery was interrupted, timed out or lacked a confirmed receipt; reconcile with platform history instead of blindly sending again |

An API/CLI receipt proves platform acceptance, while a recipient matching the
Run ID and complete report provides independent group-window confirmation.
Keep those checks separate. The native adapter may normalize Markdown into
rich text; a displayed report is not a byte-identical file transfer. Preserve
the source report hash and validate any file attachments separately.

Keep the browser's **Auto investigate** off for alerts assigned to this worker
to avoid a second, independent investigation. The worker's SQLite deduplication
does not control manual clicks or other browser automation.

## Acceptance procedure

1. Verify both services are enabled/running, `Linger=yes`, and `last-poll.json`
   records the initial baseline.
2. In an approved test namespace, create a new labelled failure or telemetry
   fixture and a real Prometheus rule. Use a new Run ID, and verify source
   `pending`/`firing` and the corresponding Alertmanager fingerprint.
3. Leave the MOSAIC browser closed. Do not click **Start Investigating**, call
   the headless API manually, supply a follow-up prompt or run a send script.
4. In Agent mode observe `investigating → ready → sending → sent`, then inspect
   actual native tool requests/results. Record whether the Agent chose research,
   its exact questions, returned sources, unavailable tools and remaining gaps.
   Staged-mode reproductions instead show
   `collecting → researching → synthesizing → ready → sending → sent`.
5. Confirm the complete report arrived from the **application bot**, preserving
   the Run ID and incident/session identity. The custom-bot Webhook is a
   different sender.
6. With `delivery.session_key` configured, confirm the full report is present
   in a real Agent input record. Have the recipient ask a normal, unquoted
   question in the same DM without copying the report or its Run ID. Correlate
   the real platform input, Qwen's contextual answer and the native reply. A
   display mirror or the automatic handoff's own answer is not this acceptance.
7. Restart the worker while the same source alert remains active. Confirm the
   same incident/message ID remains, without another investigation or delivery.
8. Have the test administrator delete only the exact test objects. Verify the
   source alert clears and only the worker-owned MOSAIC card is removed; keep
   the complete conversation and evidence.

Real Feishu DM, group mention, unmentioned group messages, unallowlisted users
and groups, and post-gateway-rebuild delivery are separate channel acceptance
cases. Tests using replayed policy inputs must be labelled as replays; they do
not establish that a second real user identity was rejected.

## Recorded deployment validation (2026-11-02)

The original **staged-mode** host-service implementation was exercised against an existing kind
deployment with OpenClaw/Feishu `2026.6.10`, IRAOP and an indexed two-page GPU
runbook. A new isolated DCGM cache sample was replayed by a Pod without GPU
resources; a real Prometheus rule and Alertmanager produced the selected alert.
The production DCGM cache and all eight GPUs' NVML ECC/remap counters were
unchanged. This was telemetry simulation, not a physical GPU failure.

| Check | Observed result |
| --- | --- |
| Browser-independent execution | Worker imported the alert, collected five actual diagnostic tool results, called IRAOP and synthesized in the same View automation session |
| Research | Real `iraop_query` response returned an answer with two filename/page source rows |
| Complete publication | Original model report: 9,469 UTF-8 bytes; complete published report with metadata: 11,966 bytes; no truncation or factual corrections |
| Native delivery | Native Feishu CLI returned a real message ID; platform message readback returned `code=0`; recipient confirmed the complete matching Run ID and incident |
| Restart deduplication | Restarted the worker while the source remained firing; incident ID, message ID, every event row and all report/evidence hashes stayed identical |
| Source resolution | Deleted six test objects with exact UID API preconditions; Alertmanager returned zero matching alerts and the worker cleared its three attempt cards while preserving histories |
| Existing deployment | Helm revision and seven ready Pods preserved; application Secret fingerprints and shared model process unchanged |
| Native channel rebuilding | Recreated the gateway Pod; real allowlisted DM and group mention both received model-generated replies afterward |
| Policy replay | Nine cases ran through the installed plugin's actual policy exports; unlisted synthetic users/groups were rejected, and an allowlisted unmentioned group sender was skipped |
| Remaining identity acceptance | No second real account was available; synthetic policy replay does not replace that test |

Two earlier attempts stopped before publication: first because an intermediate
headless response was mistaken for completed work, then because a valid IRAOP
`source_file` field was not recognized. Their complete requests, responses and
failed incident records were retained. The successful attempt used the native
history completion check and the exact IRAOP envelope covered by regression
tests; it did not resume a failed record or manually send its report.

The complete dated operator record, commands, original model output, all
attempts and channel evidence are maintained in the deployment documentation
[pull request](https://github.com/JeffPengCoder/AI-Factory-Operations-Agent/pull/1).

### Direct-message context regression and new automatic run

An ordinary follow-up after a proactive DM exposed a separate defect: the
report had arrived in Feishu, but its display-only `delivery-mirror` record did
not enter the model's replay context. A second candidate also exposed the
default 8,000-character history display limit. Those failed records and original
model answers were retained; they were not edited or manually completed.

The revised worker transfers the complete report through the normal `agent`
method before publishing. A separate two-turn component probe first confirmed
that normal Agent inputs survive into a later real model turn with external
delivery disabled. A fresh alert then exercised the persistent service itself:

| Field | Observed value |
| --- | --- |
| Run ID | `handoff-gpu-20261102t085400z` |
| Incident | `3b0084bf90af7f0901912918` |
| Collection | Five actual `run_kubectl` tool results; all successful |
| IRAOP | Two source rows, runbook pages 1 and 2 |
| Original model report | 12,186 UTF-8 bytes; SHA256 `bd8b666916caae931e0b6e119200c5b203ffdfd984875ce28e62648e92e68277` |
| Published report | 14,675 UTF-8 bytes; SHA256 `d6fd75fb6218ecba9c9272fb5a2d0f259fac28317c6bc0d9eb0d977ec186db8a` |
| Real recipient input | Record `8a93da79`; complete report verified before publication |
| Native platform receipt | `om_x100b61b14468f570dd6b4d1203771ad`; readback confirmed the expected p2p conversation |
| Worker completed | `2026-11-02T08:58:19Z`; no manual collection, Research, context insertion or report sending during acceptance |
| Restart while firing | Same incident ID, message ID, every event row and all incident evidence hashes; worker active |
| Ordinary human follow-up | Real unquoted DM `om_x100b61b10605d080cf1d0f49f92aac4`: “你能用几句话总结一下刚才的报告吗？”; no copied report or Run ID |
| Contextual model answer | Qwen record `5eeb1905` summarized the isolated DCGM injection, hardware comparisons and the report's conclusion; native reply `om_x100b61b107bb6cbcdf14d7179173091` was recorded in the same p2p conversation |

The receipt-only handoff's model output was retained in full. It was not
published or used to rewrite the report. The original model report remains
fact-uncorrected; this regression test establishes context transport, not the
accuracy of GPU hardware diagnosis.

## Stop and retain evidence

```bash
systemctl --user disable --now \
  mosaic-alert-worker.service mosaic-alert-ui-forward.service
```

Retain the private state directory and original reports. Stopping these user
services does not alter the MOSAIC release, native channel, knowledge collections
or shared model process. Do not clear the incident ledger to force a retry of
an ambiguous send.
