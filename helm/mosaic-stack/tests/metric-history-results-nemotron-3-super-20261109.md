# Nemotron 3 Super NVFP4 missing-metric backtest

Observed on 2026-11-09 UTC. This is the five-case isolated model/tool replay for PR #104, not a general model benchmark or native OpenClaw acceptance test.

The candidate improves evidence retrieval, but the complete answers remain unreliable. Under the pre-run rubric, baseline passes **0/15** and candidate **3/15**. Correct original last-sample times appear in **0/9** baseline gap answers and **7/9** candidate gap answers. These are different measurements: finding a correct timestamp does not establish a correct final conclusion.

The source-sample helper is useful; this result does **not** justify closing #103. Follow-up backtracking, known-cadence handling, and factual output consistency still need native-runtime work.

## Exact experiment

| Field | Value |
| --- | --- |
| Model | `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4` |
| Weights revision | `ff433f5493e25d631c9f12b5d55c674229923d02` |
| Precision | Unchanged ModelOpt mixed policy: 40,961 NVFP4 and 139 FP8 entries; FP8 KV cache |
| Hardware / serving | DGX Spark GB10; driver 580.173.02; Linux ARM64; vLLM 0.27.1; Torch 2.13.0+cu130 |
| ARM64 image | `vllm/vllm-openai@sha256:1c8e60a0841b333c700488cb029d3664807249da0c071e862191b00fe34b228c` |
| Baseline | `307afa7e485a334389b4f2c8c68128fbf84ff007` |
| Candidate | `8305d59e44470e10d268a4e60fc36870929b2e27` |
| Protocol | Checkpoint-pinned tokenizer/template and `super_v3` reasoning parser; `qwen3_coder` tool parser |
| Generation | Temperature 1.0; top_p 0.95; thinking explicitly disabled; seeds 1, 2, 3 |
| Budgets | 24 model turns; 8,192 generated tokens per turn; 180,000 ms per request |
| Capacity | One serial replay and one serving sequence; 262,144-token context; TP=PP=DP=1 |
| Cache | Normal request behavior; no request salt. This server reports prefix caching disabled |
| Data | Real Prometheus 3.16.0; all 30,121 synthetic original samples validated; fixed investigation time 2026-11-06T00:00:00Z |
| Coverage | Five cases × three seeds × two revisions = 30 canonical model outcomes |

The model is **Nemotron 3 Super**, not the different 3.5 Super VL checkpoint in the current AFOA Super profile. Thinking-disabled settings mirror that profile choice; they do not measure thinking-enabled performance. The customer's actual model was not established by this experiment.

The two legacy environment variables `VLLM_NVFP4_GEMM_BACKEND` and `VLLM_USE_FLASHINFER_MOE_FP4` were reported as unknown by this image. Effective kernels were FlashInfer/Cutlass NVFP4 linear operations and Marlin MoE, as recorded in the full serving record. Quantization was automatically detected as `modelopt_mixed`; weights were not converted.

## Review method and limitations

Codex checked each complete answer and its tool evidence against the [pre-run rubric](metric-history-replay.md#review-every-answer-against-its-evidence). This is not a blinded human evaluation. Pass requires the required case finding without a material contradiction or unsupported conclusion elsewhere in the answer. All answers and reasons are retained in the accompanying JSON for independent review.

For the zero-valued series, 2/3 baseline and 3/3 candidate answers recognized presence. Their complete-answer verdicts still fail because they asserted idle/no-workload state or collector health from utilization alone; one baseline answer actually inferred collection failure from zeros. These distinct findings must not be collapsed into a single claim that the model cannot recognize zero.

Candidate three-day-gap seed 2 is accepted with a documented precision note: both boundary timestamps and actual search coverage are correct, but its approximate duration uses sample age (three days one minute), one cadence interval longer than time since the first expected absence. The helper call omitted the optional cadence; the one-minute estimate is instead supported by the cadence supplied in the system prompt. Other gap failures either omit that distinction or contain materially wrong dates, durations, coverage, or limits.

Each seed is one observation, not a statistical guarantee. Matching seeds do not guarantee bitwise identical outputs. The suite explicitly loads the skill and real plugin with only SDK registration stubbed; it does not exercise automatic skill selection, full native prompts, session routing, UI, or final-output enforcement. No serving/cache change is proposed by these results.

## Every canonical outcome

Durations are milliseconds as recorded by the runner, not rounded estimates. B = baseline, C = candidate. Token columns sum all model turns; the JSON retains each individual usage object.

| Side | Case | Seed | Stop | Turns | Tool calls | Tool errors | Backend requests | Elapsed ms | Prompt tokens | Completion tokens | Whole-answer review |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| baseline | three-day-gap | 1 | stop | 22 | 21 | 4 | 19 | 260086.234375 | 112292 | 3126 | fail |
| baseline | three-day-gap | 2 | stop | 4 | 3 | 0 | 3 | 71130.164292 | 17827 | 1005 | fail |
| baseline | three-day-gap | 3 | stop | 10 | 9 | 0 | 9 | 121235.46570799999 | 53543 | 1487 | fail |
| baseline | history-unavailable | 1 | stop | 13 | 12 | 0 | 12 | 173526.92987500003 | 70663 | 2195 | fail |
| baseline | history-unavailable | 2 | stop | 4 | 3 | 0 | 3 | 54876.97199999995 | 11367 | 791 | fail |
| baseline | history-unavailable | 3 | stop | 10 | 9 | 0 | 9 | 143930.376583 | 35512 | 1996 | fail |
| baseline | healthy-zero | 1 | stop | 6 | 5 | 0 | 5 | 76637.89241700002 | 20916 | 1040 | fail |
| baseline | healthy-zero | 2 | stop | 3 | 2 | 0 | 2 | 37269.4169999999 | 11540 | 492 | fail |
| baseline | healthy-zero | 3 | stop | 3 | 2 | 0 | 2 | 53659.87624999997 | 11538 | 765 | fail |
| baseline | two-hour-gap | 1 | stop | 5 | 4 | 0 | 4 | 57634.843125000014 | 18529 | 767 | fail |
| baseline | two-hour-gap | 2 | stop | 3 | 2 | 0 | 2 | 38191.36337500007 | 11589 | 509 | fail |
| baseline | two-hour-gap | 3 | stop | 4 | 3 | 0 | 3 | 83473.820084 | 23712 | 1154 | fail |
| baseline | three-day-gap-followup | 1 | stop | 3 | 2 | 0 | 3 | 14951.630125000025 | 8555 | 162 | fail |
| baseline | three-day-gap-followup | 2 | stop | 4 | 3 | 0 | 4 | 53945.77766600007 | 15348 | 744 | fail |
| baseline | three-day-gap-followup | 3 | stop | 2 | 1 | 0 | 2 | 18542.130292000016 | 5697 | 247 | fail |
| candidate | three-day-gap | 1 | stop | 4 | 3 | 0 | 7 | 60741.11075 | 18673 | 821 | fail |
| candidate | three-day-gap | 2 | stop | 4 | 3 | 0 | 7 | 62153.414958 | 18605 | 840 | pass |
| candidate | three-day-gap | 3 | stop | 5 | 4 | 0 | 8 | 65861.58895800001 | 23542 | 850 | fail |
| candidate | history-unavailable | 1 | stop | 3 | 2 | 0 | 10 | 56609.450709 | 14634 | 793 | pass |
| candidate | history-unavailable | 2 | stop | 4 | 3 | 0 | 11 | 53374.12275000004 | 19102 | 699 | pass |
| candidate | history-unavailable | 3 | stop | 4 | 3 | 0 | 11 | 41847.43212499999 | 18824 | 497 | fail |
| candidate | healthy-zero | 1 | stop | 4 | 3 | 0 | 3 | 56204.36637500004 | 19382 | 740 | fail |
| candidate | healthy-zero | 2 | stop | 10 | 9 | 0 | 9 | 172472.60320800002 | 143220 | 1459 | fail |
| candidate | healthy-zero | 3 | stop | 3 | 2 | 0 | 2 | 43697.91341600008 | 14900 | 565 | fail |
| candidate | two-hour-gap | 1 | stop | 4 | 3 | 0 | 4 | 61339.434583000024 | 18156 | 806 | fail |
| candidate | two-hour-gap | 2 | stop | 5 | 4 | 0 | 5 | 71659.88299999991 | 23257 | 927 | fail |
| candidate | two-hour-gap | 3 | stop | 4 | 3 | 0 | 4 | 60770.42316699994 | 18141 | 819 | fail |
| candidate | three-day-gap-followup | 1 | stop | 2 | 1 | 0 | 5 | 24349.793666000012 | 10290 | 304 | fail |
| candidate | three-day-gap-followup | 2 | stop | 2 | 1 | 0 | 5 | 45494.16991699999 | 10290 | 662 | fail |
| candidate | three-day-gap-followup | 3 | stop | 2 | 1 | 0 | 6 | 27443.519417000003 | 10619 | 348 | fail |

## Transport reconciliation and smoke outcomes

The original formal baseline three-day-gap seed-1 attempt ended with `TypeError: fetch failed` after two successful tool calls. It has no final answer and is not an accuracy zero. The endpoint remained healthy; the remaining runs proceeded. One same-seed retry completed with 21 tool calls and four tool errors, then gave an incorrect September onset. That valid model failure is the canonical result. The original failed attempt remains in the JSON. No low-quality answer was retried to improve the score.

Both smoke replays completed and invoked tools, but both failed factual review. They are outside the formal denominator.

| Stage | Side | Case | Seed | Stop | Turns | Tool calls | Tool errors | Backend requests | Elapsed ms | Review |
| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | --- |
| smoke | baseline | three-day-gap-followup | 1 | stop | 5 | 4 | 0 | 5 | 64337.828041999994 | fail |
| smoke | candidate | three-day-gap-followup | 1 | stop | 2 | 1 | 0 | 5 | 23275.22475 | fail |
| formal-attempt-1 | baseline | three-day-gap | 1 | replay_error | 2 | 2 | 0 | 2 | 34881.631458 | not_assessed |

## Complete review record

[metric-history-results-nemotron-3-super-20261109.json](metric-history-results-nemotron-3-super-20261109.json) contains all 30 full final answers and reviews, all per-turn token usage, both smoke answers, the failed transport attempt, both source file-hash inventories, every checkpoint-file integrity result, the exact serving command/settings, full timing/tool-call distributions and the retained-artifact hash manifest.

It is a compact run record, not the full request/response rollout. Full requests, backend/tool results and source snapshots remain retained externally; deployment-specific addresses, workspace paths and recovery details are not published.

Reproduce with [metric-history-replay.md](metric-history-replay.md), the exact pins/settings above, and the generated fixture. The source revision with the recorded results adds documentation only; the tested candidate code remains the pinned commit listed above.
