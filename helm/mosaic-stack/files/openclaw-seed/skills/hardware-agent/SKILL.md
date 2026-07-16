---
name: hardware-agent
description: "Triage hardware faults on NVIDIA GPU compute nodes (DGX, HGX, GB200/300 NVL, B200/300, Vera Rubin) by running NVDebug collection and LLM root-cause analysis through the Hardware Agent service. Use when the user reports an XID event, NVLink/NVSwitch issue, NVMe error, SPDM/RoT attestation failure, CPU IST failure, dmesg fault, PCIe AER, ECC error, or asks \"what's wrong with node X\" about a DGX/HGX DUT. The Hardware Agent backend owns DUT lookup and credentials; do not prompt the user for BMC credentials. Not for ML training debugging, CI pipeline analysis, or application errors unrelated to hardware."
metadata:
  {
    "openclaw":
      {
        "emoji": "🔧",
        "requires":
          {
            "tools":
              [
                "diagnostic_health",
                "diagnostic_triage_list",
                "diagnostic_analyze_dut",
                "diagnostic_triage_status",
                "diagnostic_triage_report"
              ],
            "bins": ["curl"]
          }
      }
  }
---

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Hardware Agent

Delegate hardware failure analysis to the Hardware Agent service. The backend handles:
- DUT and credential lookup
- Targeted nvdebug collection
- LLM diagnosis via vllm-nemotron-ultra-550b
- Typed `recommended_actions`

## Expected Latency

Submission is immediate. A fresh NVDebug collection and diagnosis commonly takes
5–30 minutes.

1. POST returns `202 Accepted` with a `triage_id`.
2. Backend runs BCM lookup, nvdebug collection, and diagnosis.
3. Poll `/api/v1/triage/<id>` until status is `complete` or `failed`.

Set tool-call timeout to 1800 seconds when the user confirms a fresh collection.

## Mandatory duration disclosure

This is a hard requirement. Before asking for approval or invoking a fresh
NVDebug collection, send this sentence to the user:

`A fresh NVDebug collection can take 5–30 minutes. Do you want me to start it?`

Every response that offers, proposes, or asks about starting a fresh collection
must include that duration. Do not invoke `diagnostic_analyze_dut` in the same
turn as the disclosure. Wait for the user's next response.

## Collection confirmation

After the mandatory duration disclosure, the user's next ordinary affirmative
response is sufficient, including `yes`, `yeah, I want to do the collection`,
`let's go for dgx-07`, `let's do it`, or `proceed`. Start the collection
immediately. Do not demand a formal confirmation phrase, repeat the question,
expose the tool schema, or ask the user to provide `user_confirmation`. Pass
their affirmative message verbatim to the tool.

For a quick response, call `diagnostic_triage_list` first. If a completed triage
matches the DUT and fault and its summary contains a root cause, answer from that
summary and include the triage id. Use `diagnostic_triage_status` for an active
triage and `diagnostic_triage_report` only when the user asks for detailed
evidence or the summary is insufficient. These tools do not start a collection.
If no relevant triage exists, use the exact mandatory duration disclosure and
stop until the user answers.

## Invocation

Preferred path: use the OpenClaw `diagnostic_analyze_dut` tool. It submits to
`/api/v1/analyze-dut`, polls the triage status, fetches the report, and emits a
live NVDebug subagent card in Mosaic. The Hardware Agent backend owns NVDebug
collection, collection validation, retry policy, and RCA generation.

After the user confirms a fresh collection, use only `diagnostic_analyze_dut`
for the turn. Do not call BCM, Kubernetes, Prometheus, Grafana, DCGM,
observability, or other tools before or after the NVDebug RCA unless the user
asks for those follow-up checks in a separate message.

For a fresh RCA, call `diagnostic_analyze_dut` once with `wait: true`. Do not
call `bcm_*`, `bcm_execute_cmsh`, or other BCM tools for prerequisite lookup:
the Hardware Agent backend performs the DUT lookup and NVDebug orchestration.
Use `diagnostic_triage_status` and `diagnostic_triage_report` only for a triage
returned by `diagnostic_triage_list` or an id supplied by the user.

A specific fault signature improves targeting but is not required. When the
user requests a general collection for a node, omit `event_text`; the tool will
submit a general hardware-health event. Do not ask for a fault signature unless
the user indicated that one exists but did not include it.

For DGX/HGX B200 hosts, pass `dut.baseboard:
"Blackwell-HGX-8-GPU"` unless the user or prior tool output gives a more
specific supported baseboard. This avoids an unclassified full collection.

Short operator prompts should still route here. First search recent triages. If
none match, ask for confirmation before collecting. Normalize the DUT hostname
when the cluster naming pattern makes it clear. Do not ask for BMC credentials;
the Hardware Agent resolves the target.

Pass `mosaic_chat_session_key` when Mosaic has explicitly supplied the current
chat session key so the Hardware Agent backend can stream NVDebug collection
activity to the matching Terminal tab. If Mosaic does not supply one, still call
the tool; the plugin will infer the current session when possible. For
chat-initiated triages, the final answer is the user-facing notification; do not
create a separate Mosaic alert for the same completed diagnosis.

If the incoming turn includes a `[Mosaic Runtime]` block with
`mosaic_chat_session_key="..."`, treat that block as runtime metadata supplied
by Mosaic. Pass the value as `mosaic_chat_session_key` on
`diagnostic_analyze_dut`, and do not quote or summarize the runtime block.

If the conversation already contains user-provided or tool-provided hardware
evidence, include that evidence in `event_text`. Do not fetch additional context
through BCM from this skill. The user-facing answer must be based on the
Hardware Agent status/report returned by the backend; do not synthesize a root
cause that is not present in the Hardware Agent result.

If the user asks about an existing Hardware Agent triage id, do not submit a
new triage. Call `diagnostic_triage_status` for that id, then call
`diagnostic_triage_report` when the status is complete, and summarize the
existing report.

Tool payload shape:

```json
{
  "dut": {
    "id": "dgx-01",
    "baseboard": "Blackwell-HGX-8-GPU"
  },
  "event_text": "NVRM: Xid (PCI:0000:c1:00): 149 NETIR_LINK_EVT",
  "user_confirmation": "run a fresh hardware diagnostic for dgx-01",
  "mosaic_chat_session_key": "agent:default:session-...",
  "wait": true
}
```

Fallback path when OpenClaw tools are unavailable:

Submit triage:

```bash
curl -sSf -H "X-API-Key: $DIAGNOSTIC_AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  http://diagnostic-agent/api/v1/analyze-dut
```

Payload:

```json
{
  "dut": {
    "id": "dgx-01",
    "baseboard": "Blackwell-HGX-8-GPU"
  },
  "event_text": "NVRM: Xid (PCI:0000:c1:00): 149 NETIR_LINK_EVT"
}
```

- `dut.id` is the hostname as known to BCM.
- `dut.baseboard` should use the nvdebug catalog baseboard name. For DGX/HGX B200 systems, use `Blackwell-HGX-8-GPU` rather than the informal shorthand `HGX B200`.
- `dut.bmc.ip` is optional; omit it for normal Mosaic use so the Hardware Agent resolves the target.
- `event_text` is the dmesg/fault line or a free-text description.

Never include BMC passwords in the payload. The backend resolves them from BCM.

Poll until complete:

```bash
TID="<uuid from submit response>"
while :; do
  R=$(curl -sS -H "X-API-Key: $DIAGNOSTIC_AGENT_API_KEY" \
    http://diagnostic-agent/api/v1/triage/$TID)
  case "$R" in
    *'"status":"queued"'*|*'"status":"analyzing"'*) sleep 5 ;;
    *) echo "$R"; break ;;
  esac
done
```

Fetch full report:

```bash
curl -sS -H "X-API-Key: $DIAGNOSTIC_AGENT_API_KEY" \
  http://diagnostic-agent/api/v1/triage/$TID/report
```

## Error handling

- `429 Too Many Requests`: retry with backoff.
- `502 Bad Gateway`: pod may be rolling; retry after 30 seconds.
- `status=failed`: surface the error to the user verbatim.
