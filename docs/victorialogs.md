# VictoriaLogs query reference

For endpoint setup, authentication, Secrets, tenancy, and verification, see
[Read-only VictoriaLogs](installation.md#read-only-victorialogs).

## Connection options

Connection settings are documented in the
[installation guide](installation.md#read-only-victorialogs).

## Discovery and queries

Ask the agent to discover available VictoriaLogs fields and values, then query
a selected source over a specific time range. `observability_victorialogs_fields`
accepts an optional `field` and LogsQL `query` filter. Field results include
values and hit counts. `observability_victorialogs_query` accepts a required
LogsQL `query` and returns JSON rows, preserving timestamp strings and fields.
For example, after discovering a `service` field and its values:

```text
service:="scheduler" error
service:="scheduler" | stats count() as events
```

Both tools support ISO 8601 `start` and `end`, defaulting to the past hour, and
`limit`, defaulting to 100. Windows must be positive and at most 24 hours;
limits must be between 1 and 1000. Queries time out after 15 seconds and responses
are capped at 2 MiB. Narrow the query when these bounds are reached. The row
limit also applies to aggregates; `limitReached` means the result may be incomplete.
These tools work in View mode and can coexist with Loki and metrics tools.

See the upstream [VictoriaLogs query API](https://docs.victoriametrics.com/victorialogs/querying/)
and [LogsQL reference](https://docs.victoriametrics.com/victorialogs/logsql/).
