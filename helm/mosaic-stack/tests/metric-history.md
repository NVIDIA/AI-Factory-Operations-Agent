# Historical metric evidence checks

These checks exercise the existing `observability_query` and
`observability_range_query` tools. No dedicated investigation tool is added.
The candidate retains PR #104's endpoint-preserving compaction and sampling
metadata. Populated range queries also request `timestamp(query)` over the same
window and step. Returned points retain their numeric metric values and receive
separate sample clocks, with a `lastSampleTimeIso` summary per series. For plain
selectors these are original source times; calculated expressions can have
derived clocks. Evaluation times remain separate.

The extra query is read-only and adds backend work. If it fails, is partial, or
cannot provide usable sample clocks, metric results remain available and
`sampleTimeStatus` reports unavailable. No source timestamp or onset is invented.
Empty windows do not trigger the extra query. Historical evidence rules are
included in the agent context whenever observability is enabled.

Empty results establish only what the selected query returned; zero remains a
present sample. Neither query boundary establishes an incident onset.

## Focused tests

From the repository root, with Node.js 24 or newer:

```bash
node --test helm/mosaic-stack/tests/observability-history.test.mjs \
  helm/mosaic-stack/tests/victoriametrics.test.mjs
```

The tests cover endpoint preservation, point/series truncation disclosure,
empty history, source/evaluation timestamp separation, ordinary metric value
compatibility, and unavailable sample clocks. The real-backend test is
optional and requires the isolated fixture below.

## Real Prometheus fixture

Use matching Prometheus and promtool releases. Start from a fresh temporary
TSDB, import the synthetic OpenMetrics fixture, and run an isolated Prometheus
with no live scrape targets:

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

In another terminal at the repository root:

```bash
MOSAIC_HISTORY_TEST_URL=http://127.0.0.1:19093 \
  node --test helm/mosaic-stack/tests/observability-history.test.mjs
```

Stop the isolated Prometheus after testing. Never import fixture blocks into a
running TSDB or point these tests at a production metrics backend.

The fixture has 60-second samples beginning 2026-10-29T00:00:00Z and an
investigation time of 2026-11-06T00:00:00Z. It covers a multi-day gap, a shorter
gap, a present zero, and no history. No stale markers are inserted, so backend
lookback is exercised. The test queries actual source timestamps through the
existing tools and verifies that compaction retains the final returned sample.

## Native validation deployment

The fixture directory is also a standalone test-only Helm chart. Install it
into a fresh validation namespace to generate and import the same complete
history in an isolated Prometheus pod. Its optional `uiHost` creates an ingress
to the Mosaic UI in that namespace. `fixtures/mosaic-values.yaml` selects only
the modules needed for this new test deployment. Supply an authorized inference
URL, model, and existing Secret via Helm overrides; no credentials are stored
in these fixtures. Use the same chart settings for baseline and candidate.
Leave `openclaw.bootstrapSkills` empty to test automatic skill selection.
When reusing a self-hosted Qwen server, layer the tracked Qwen profile before
external endpoint overrides so its reasoning metadata and thinking level match
the shipped defaults. External-endpoint defaults alone disable reasoning and
are a separate comparison. Keep the same model profile on both revisions.

## Conversation acceptance

Tool tests do not prove that the agent selects the observability skill,
searches older history, or answers accurately. Validate the deployed Mosaic
conversation with automatic skill selection and the normal inference setup.
Use fresh sessions and repeat baseline, candidate, reverted baseline, and
restored candidate runs against identical synthetic history. Include direct
onset questions, follow-ups after empty recent queries, no history, zero-valued
samples, ambiguous sources, and backend failures. Inspect tool traces and final
answers for evidence-backed timestamps, source scope, cadence, coverage, and
uncertainty. Record remaining failures rather than treating tool tests as proof
that the issue is closed.
