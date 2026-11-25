# Loki query reference

For connection setup and verification, see [Read-only Loki logs](installation.md#read-only-loki-logs).

## Connection options

Authentication, Secrets, tenancy, endpoint behavior, and verification are covered
in [Read-only Loki logs](installation.md#read-only-loki-logs).

## Ask about your logs

In View mode, ask Mosaic to find logs, count matching events, or show how activity
changes over time. For example:

- “Which services have logs available?”
- “Show errors from the scheduler over the past 15 minutes.”
- “How many errors did that service log in the last hour?”
- “Show its error rate over the last hour.”

Include the service or host and the time range you want to investigate.

## Query limits

| Query setting | Default | Maximum |
| --- | --- | --- |
| Range query time window | Past hour | 24 hours |
| Returned entries | 100 | 1,000 |
| Upstream response size | — | 2 MiB |
| Request duration | — | 15 seconds |

If a query reaches a limit, narrow the source labels or time window.
