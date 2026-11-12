# Missing metric history regression

The `observability_metric_last_seen` tool searches adjacent original-sample
windows, newest first. An empty recent query does not date an incident. Unlike
`query_range`, a raw range selector sent to the Prometheus instant query API
returns source timestamps without lookback reuse or step downsampling.

The tool keeps the metric and exact label selection fixed. It checks one hour,
the preceding six hours, then adjacent 24-hour windows, stopping at the newest
sample or the requested history bound. Defaults are seven days, 32 requests,
20 seconds total, five seconds per request, and 2 MiB per response. The maximum
requested history is 30 days. Errors, partial responses, native histograms, or
non-matrix responses fail closed. Multiple matching series require more exact
labels; the tool does not combine their last-seen times. A zero-valued sample
is present, and a non-finite sample does not establish health.

Only an independently known sampling interval permits a first-missed-expected
sample estimate. This is not an exact physical network or collector failure
time. Actual searched coverage and the requested budget are separate. This
coverage is not outage duration: `elapsedSinceLastSample` formats the age of
the original sample without requiring the model to subtract epoch timestamps.
An entirely empty history does not prove that the series ever existed or that
an outage started before the checked window. This
tool does not locate threshold breaches or previous gaps that have recovered.
Backends that substitute evaluated vectors for raw range vectors are not
supported by this tool; the existing generic query tools remain available.

## Unit tests

From the repository root, with Node.js 24 or newer:

```bash
node --test helm/mosaic-stack/tests/metric-history.test.mjs \
  helm/mosaic-stack/tests/observability-history.test.mjs \
  helm/mosaic-stack/tests/automation-context.test.mjs
```

These cover continuous window boundaries, exact source time, zero/non-finite
values, missing cadence, empty history, bounded work, ambiguous sources, escaped
labels, rejected input, transport errors, partial responses, malformed results,
and registration/permission controls. Helm rendering tests additionally check
ConfigMap contents, runtime copying, the plugin contract, and module disabling.

## Real Prometheus fixture

Use Prometheus and promtool from the same release. The fixture was tested with
Prometheus 3.16.0. Put those binaries on `PATH`. This imports only generated
samples into a fresh temporary TSDB and does not scrape any live target.
Run from the repository root:

```bash
metric_history_dir=$(mktemp -d)
node helm/mosaic-stack/tests/fixtures/metric-history.mjs > "$metric_history_dir/samples.openmetrics"
promtool tsdb create-blocks-from openmetrics \
  "$metric_history_dir/samples.openmetrics" "$metric_history_dir/tsdb"
prometheus \
  --config.file=helm/mosaic-stack/tests/fixtures/metric-history-prometheus.yml \
  --storage.tsdb.path="$metric_history_dir/tsdb" \
  --storage.tsdb.retention.time=10000d \
  --web.listen-address=127.0.0.1:19093
```

Keep that process running. In another terminal at the same repository root:

```bash
MOSAIC_HISTORY_TEST_URL=http://127.0.0.1:19093 \
  node --test helm/mosaic-stack/tests/metric-history.test.mjs
```

Stop the foreground Prometheus with Ctrl-C after testing. The temporary data
can be retained for inspection. Do not import blocks into a running TSDB.

All fixture samples are generated at 60-second intervals starting
`2026-10-29T00:00:00Z`, with investigation time `2026-11-06T00:00:00Z`.
No stale markers are inserted, so real Prometheus lookback behavior is exercised.

| Scenario | Hostname | GPU | Value | Sample count | Last original sample UTC | First expected missing sample UTC |
| --- | --- | --- | ---: | ---: | --- | --- |
| Three-day gap | fixture-gpu-a | 0 | 42 | 7200 | 2026-11-02T23:59:00Z | 2026-11-03T00:00:00Z |
| No available history | fixture-gpu-b | 0 | No values | 0 | Unknown | Unknown |
| Healthy presence at zero | fixture-gpu-c | 0 | 0 | 11521 | 2026-11-06T00:00:00Z | None |
| Two-hour gap | fixture-gpu-d | 0 | 23 | 11400 | 2026-11-05T21:59:00Z | 2026-11-05T22:00:00Z |

The generator emits every one of the 30121 samples. It can also support
the [matched model/tool replay](metric-history-replay.md) for comparing harness
revisions with the same model and fixture. Passing the deterministic tool tests does not prove
that an agent selected the skill, invoked the tool, or completed the answer;
those require separate native-runtime behavior tests.

References: [Prometheus range selectors](https://prometheus.io/docs/prometheus/latest/querying/basics/#range-vector-selectors),
[HTTP instant queries and result formats](https://prometheus.io/docs/prometheus/latest/querying/api/),
and [Mosaic issue 103](https://github.com/NVIDIA/AI-Factory-Operations-Agent/issues/103).
