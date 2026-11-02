<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Background alert investigation and native Feishu delivery

`utils/mosaic-alert-worker.py` runs on the deployment host as a persistent user
service. It polls an existing Alertmanager, imports selected alerts into MOSAIC,
collects actual diagnostic tool evidence through the headless API, calls IRAOP,
requests a complete report, and publishes through the configured OpenClaw native
Feishu channel. An open browser is not required.

The operator explicitly selects both the alert labels and the destination group.
The default first poll records already-active alerts without investigating them.
New alerts are keyed by fingerprint **and** start time in a persistent SQLite
database. Restarting a completed worker does not send the same report again.

## Processing and permissions

```text
Existing Alertmanager, explicitly selected labels
    -> persistent worker + SQLite incident ledger
    -> MOSAIC alert API
    -> headless API, View: actual logs / state / metrics
    -> actual iraop_query, explicit knowledge collections
    -> same read-only session: complete report
    -> separate fixed native CLI publisher
    -> OpenClaw Feishu plugin -> approved group

Every stage -> complete private requests, responses and evidence
```

Every investigation uses
`agent:default:mosaic-automation-alert-<incident-id>`. This matches the existing
automation guard, which keeps the session read-only even if the installation
also supports interactive Edit/Auto sessions. The worker does not change access
mode or request cluster mutations.

Publication is an independent operator action. The worker calls a fixed
`kubectl exec ... node /app/dist/index.js message send --channel feishu` argument
array against the configured gateway deployment. The agent cannot choose the
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
| Explicit label filter | Select the intended alert population; initially use dedicated test labels |
| IRAOP | Working `iraop_query`, approved indexed documents and explicit collection names |
| Existing native Feishu channel | Published application, loaded plugin, authorized group and working native send |
| Kubernetes context | The host account can port-forward the UI and invoke the selected gateway's native CLI |
| Persistent local state | Private writable disk under `~/.local/state/mosaic-alert-worker` |
| Service ownership | A customer administrator approves startup, maintenance, token rotation and the report's sharing scope |

Customer application creation, publication, organization approval, group
membership, corpus authorization and host credentials remain customer actions.
Installing MOSAIC alone supplies none of those approvals. Native Feishu uses an
App ID/App Secret; a custom-bot Webhook URL is a separate delivery credential.

## Install the persistent services

Run on the Linux deployment host from a checkout containing this utility. Use
the actual site values, and an already functional native channel:

```bash
export KUBE_CONTEXT=kind-example
export MOSAIC_NAMESPACE=mosaic
export MOSAIC_UI_AUTH_SECRET=mosaic-ui-auth
export MOSAIC_KUBECTL="$(command -v kubectl)"
export ALERTMANAGER_URL=https://alerts.example.com
export FEISHU_CHAT_ID=oc_REPLACE_WITH_APPROVED_GROUP
export RESEARCH_COLLECTION=approved-operations-runbooks

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
    research_collections=[os.environ["RESEARCH_COLLECTION"]],
)
config["delivery"].update(
    kubectl=os.environ["MOSAIC_KUBECTL"],
    context=os.environ["KUBE_CONTEXT"],
    namespace=os.environ["MOSAIC_NAMESPACE"],
    target="chat:" + os.environ["FEISHU_CHAT_ID"],
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
example initially selects only alerts with both `mosaic_test=true` and
`background_validation=true`. Start the service before creating the new test
alert. Set `include_existing=true` only when intentionally processing selected
alerts already firing at startup.

An optional `collection_context` provides trusted site-specific collection
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
| `collection.*` | First headless request and response |
| `collection-history.*` | Native Gateway history with actual diagnostic calls/results |
| `collection-tool-results.json` | Every collected native tool result; at least one successful diagnostic tool is required |
| `research.*` | Actual `iraop_query` request and complete response |
| `research-sources.json` | All returned source references |
| `synthesis.*` | Same-session synthesis request and complete response |
| `final-history.*` | Final native conversation history |
| `model-report.txt` | Complete, fact-uncorrected model report |
| `published-report.txt` | Complete published text with identifier redactions and report metadata |
| `report-integrity.json` | Original/published sizes, hashes and explicit no-truncation/no-factual-edit flags |
| `native-delivery.intent.json` | Fixed target/channel and complete report hash/length |
| `native-delivery.stdout.log` and `.stderr.log` | Complete native CLI output |
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
| `collecting` | Read-only diagnostic session started; actual native tool evidence is required |
| `researching` | Actual IRAOP request; answer and a usable filename/positive-page reference are required |
| `synthesizing` | Combining real observations and documentation in the same read-only session |
| `ready` | Complete report saved; safe to begin its first publication |
| `sending` | External side effect may be in flight; recorded before invoking the native CLI |
| `sent` | Native CLI returned an actual message ID; no automatic resend on restart |
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
4. Observe `collecting → researching → synthesizing → ready → sending → sent`.
   Confirm actual diagnostic tool results and the actual IRAOP response with
   sources in the incident directory.
5. Confirm the complete report arrived from the **application bot**, preserving
   the Run ID and incident/session identity. The custom-bot Webhook is a
   different sender.
6. Restart the worker while the same source alert remains active. Confirm the
   same incident/message ID remains, without another investigation or delivery.
7. Have the test administrator delete only the exact test objects. Verify the
   source alert clears and only the worker-owned MOSAIC card is removed; keep
   the complete conversation and evidence.

Real Feishu DM, group mention, unmentioned group messages, unallowlisted users
and groups, and post-gateway-rebuild delivery are separate channel acceptance
cases. Tests using replayed policy inputs must be labelled as replays; they do
not establish that a second real user identity was rejected.

## Recorded deployment validation (2026-11-02)

The host-service implementation was exercised against an existing kind
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

## Stop and retain evidence

```bash
systemctl --user disable --now \
  mosaic-alert-worker.service mosaic-alert-ui-forward.service
```

Retain the private state directory and original reports. Stopping these user
services does not alter the MOSAIC release, native channel, knowledge collections
or shared model process. Do not clear the incident ledger to force a retry of
an ambiguous send.
