# Backtest missing-metric investigation changes

This runner compares the observability plugin and skill from two repository
revisions against the same model, prompts, original metric samples and inference
settings. It addresses the missing-metric incident-onset cases in
[issue 103](https://github.com/NVIDIA/AI-Factory-Operations-Agent/issues/103).
Use the customer's exact model and serving configuration when available. A
different model, precision, reasoning setting or parser is a separate experiment.

This is an isolated model/tool replay. It loads the real observability plugin
and explicitly supplies its skill, stubbing only the OpenClaw SDK registration
wrapper. It does not test native OpenClaw skill selection, complete runtime
prompts, session routing, approvals or the UI. Those need a separate deployment
test. No score or model behavior is asserted by adding this runner.

An observed [Nemotron 3 Super NVFP4 comparison](metric-history-results-nemotron-3-super-20261109.md)
records all 30 outcomes and their factual review, including failures. Evidence
retrieval improves in that run, but complete-answer reliability and native
OpenClaw acceptance remain unresolved. Its exact configuration and full final
answers are recorded separately from the runner's deterministic tests.

## Prepare the fixture and revisions

Use Node.js 24 or newer and the running local Prometheus fixture documented in
[metric-history.md](metric-history.md#real-prometheus-fixture). The backend must
be loopback-only. The runner validates every timestamp, value and label in the
30,121 generated samples before calling the model. It will reject partial or
different data. Do not point it at a live metrics backend.

From a checkout containing this runner, choose the two commits to compare and
create separate worktrees. Replace the two commit placeholders before running:

```bash
metric_replay_dir=$(mktemp -d)
metric_replay_runner="$PWD/helm/mosaic-stack/tests/metric-history-replay.mjs"
metric_replay_base='<full baseline commit SHA>'
metric_replay_candidate='<full candidate commit SHA>'
git worktree add --detach "$metric_replay_dir/base-source" "$metric_replay_base"
git worktree add --detach "$metric_replay_dir/candidate-source" "$metric_replay_candidate"
```

Keep the runner itself fixed for both sides, including when the baseline
predates this runner. The selected source revision supplies the plugin's tools,
schemas and skill. Both revisions must have the observability plugin and
`observability_range_query`; the baseline need not have
`observability_metric_last_seen`.

The fixture fixes investigation time at `2026-11-06T00:00:00Z`. Each case tells
the model the metric, exact hostname/GPU and independently known 60-second
sampling cadence. Ground truth is saved with the results, never in the model
prompt. All five cases are included by default:

| Case ID | Hostname | Original sample count | Last original sample UTC | First expected missing sample UTC | Additional conversation context |
| --- | --- | ---: | --- | --- | --- |
| `three-day-gap` | `fixture-gpu-a` | 7200 | 2026-11-02T23:59:00Z | 2026-11-03T00:00:00Z | None |
| `history-unavailable` | `fixture-gpu-b` | 0 | Unknown | Unknown | None |
| `healthy-zero` | `fixture-gpu-c` | 11521 | 2026-11-06T00:00:00Z | None | None |
| `two-hour-gap` | `fixture-gpu-d` | 11400 | 2026-11-05T21:59:00Z | 2026-11-05T22:00:00Z | None |
| `three-day-gap-followup` | `fixture-gpu-a` | 7200 (same series as first case) | 2026-11-02T23:59:00Z | 2026-11-03T00:00:00Z | A real empty two-hour range query, followed by the user's onset question |

The follow-up obtains its seeded tool result from the selected revision and
fixture. A query failure cannot be converted into a claim of empty history.

## Freeze the model configuration and run both sides

Set the model ID to the value accepted by your server's `/v1/models` endpoint.
Also record the weights revision, precision, serving image/digest, tokenizer,
chat template, reasoning/tool parsers, context limit and cache configuration.
An API model name alone does not establish those properties. The two revision
labels below should identify that saved serving configuration; `unrecorded`
defaults are allowed for exploratory runs but limit reproducibility.

This is an example of **explicit** settings, not a universal model recipe.
Choose temperature, sampling and reasoning settings for the selected deployment
and keep them identical on both sides. The options file accepts only `top_p`,
`reasoning_effort` and `chat_template_kwargs`; omit unsupported options.

```bash
metric_replay_model_url='http://127.0.0.1:18003/v1'
metric_replay_model='<exact served model ID>'
metric_replay_model_revision='<weights revision and precision>'
metric_replay_server_revision='<serving configuration record or digest>'
cat > "$metric_replay_dir/model-options.json" <<'JSON'
{
  "top_p": 0.95,
  "chat_template_kwargs": { "enable_thinking": false }
}
JSON

for metric_replay_side in base candidate; do
  node "$metric_replay_runner" run \
    --source "$metric_replay_dir/$metric_replay_side-source" \
    --prometheus http://127.0.0.1:19093 \
    --model-url "$metric_replay_model_url" \
    --model "$metric_replay_model" \
    --model-revision "$metric_replay_model_revision" \
    --server-revision "$metric_replay_server_revision" \
    --temperature 1 \
    --model-options "$metric_replay_dir/model-options.json" \
    --repetitions 3 --max-turns 24 --max-tokens 16384 \
    --timeout-ms 180000 --cache normal \
    --output "$metric_replay_dir/$metric_replay_side-results"
done

node "$metric_replay_runner" compare \
  "$metric_replay_dir/base-results" \
  "$metric_replay_dir/candidate-results" \
  > "$metric_replay_dir/comparison.json"
```

This runs 5 cases × 3 repetitions × 2 revisions, 30 agent replays in total,
serially. Each repetition uses its number as the seed; a seed does not guarantee
bitwise determinism across servers. Output directories must not already exist.
Use `--case three-day-gap-followup --repetitions 1` for an initial smoke check,
in separate directories. Keep smoke runs separate from formal comparisons.

Defaults are temperature 0, 3 repetitions, 24 model turns, 2,200 generated tokens
per turn and 180 seconds per model request. Reasoning models may need a larger
output budget, as shown above. Exhausted budgets and errors remain in the result;
they are not silently retried or excluded. A suite exits nonzero if any answer
is unfinished or makes no model-selected tool call. Exit zero still does not
mean that the answers are correct.

For a protected model endpoint, inject `MOSAIC_REPLAY_API_KEY` into the process
environment from your secret manager. Authorization headers are not recorded;
credential-bearing URLs are rejected. Do not put credentials in model options.
Only synthetic fixture data, selected source prompts and tool results are sent
to the selected model endpoint. Confirm it is an appropriate destination.

Normal cache behavior is the default. `--cache isolated` adds a fresh
`cache_salt` to each model request for servers supporting that option. Treat
this as a separate diagnostic, match it on both sides, and do not substitute
its results for normal-cache measurements.

## Review every answer against its evidence

The comparison rejects different model IDs, model/server revision labels,
fixture hashes, runner/suite hashes, Node versions, sampling settings, budgets,
cache modes or case/repetition coverage. It retains every before/after row,
including failures, full answers, token-usage records and elapsed time.

Execution observations and factual accuracy are distinct. `completed` means
the server ended a nonempty final answer with `stop`; `investigated` means the
model requested at least one tool. Both can be true for a wrong answer. Every
row initially has `answerReview: pending` and requires this factual review:

| Case | Required finding | Claims that fail review |
| --- | --- | --- |
| Three-day gap | Cite the last original sample at 23:59 UTC on November 2 and, using the known cadence, the first expected missing sample at 00:00 UTC on November 3. | Dating onset from a recent query boundary; treating an evaluated/lookback timestamp as the original sample; contradicting those dates elsewhere in the answer. |
| No available history | Say onset is unknown from the checked evidence; report actual search coverage and any gaps. | Asserting prior existence, backend retention, or an outage predating the search without evidence; reporting the requested budget as completed coverage. |
| Healthy presence at zero | Recognize zero as a present sample, including the current sample. | Reporting missing data because the value is zero; treating presence alone as proof of complete GPU/host health. |
| Two-hour gap | Cite the last original sample at 21:59 UTC and first expected missing sample at 22:00 UTC on November 5. | Confusing Prometheus lookback reuse or the query start with the original last-present/first-missing interval. |
| Follow-up | Recover the same three-day evidence after the empty two-hour query; answer the follow-up with a supported time basis. | Treating the two-hour window as outage duration or onset; losing the source selection or repeating an unsupported earlier claim. |

For both gap cases and the follow-up, the first missed expected sample is an
estimate based on cadence, not proof of the exact physical failure time or its
cause. Review the whole answer, including suggested queries and summaries, for
contradictions. Do not require a particular tool name: a different valid query
strategy can establish the same facts.

Write a separate review record with one row per case/repetition/revision,
verdict (`pass`, `fail`, or `not_assessed`), the exact claim, supporting tool
evidence, and the reason. Report the full denominator, all excluded or failed
runs, and each baseline-to-candidate transition. Keep unknown/unavailable
measurements distinct from zero. Do not edit the original transcripts to fit
the review or score truncated answers as successful completions.

## Retained artifacts and checks

Each suite keeps `manifest.json`, full `fixture-preflight.json`, a snapshot of
every loaded observability TypeScript source file and the skill, and
`summaries.json`. Each case/repetition keeps initial messages, actual tool
schemas, every full model request/response, backend request/response, tool
result, conversation transcript and final answer. Follow-ups also save the
seeded query/result. Failures save `error.json`. Source hashes identify the
actual loaded files even if the checkout is dirty.

Keep these records and the serving manifest together in the external result
directory. Do not commit model weights, endpoint credentials or deployment
logs. Review artifacts for deployment-specific information before sharing.

The runner's own tests use a small HTTP model stub and generated metrics; they
are not evidence of real LLM accuracy:

```bash
node --test helm/mosaic-stack/tests/metric-history-replay.test.mjs
```

They cover fixture integrity, hidden ground truth, matched configuration,
full evidence capture, authentication separation, genuine follow-up context,
transport failures, missing investigation and exhausted budgets. These tests
are included by the existing CI test glob; real model runs remain opt-in.
