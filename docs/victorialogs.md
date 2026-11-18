# VictoriaLogs query reference

For installation, see [Read-only VictoriaLogs](installation.md#read-only-victorialogs).
The URL points to an existing single-node VictoriaLogs service, cluster vlselect
query service, or proxy. A configured path prefix is preserved before
`/select/logsql/`. No VictoriaLogs server or collector is installed.

## Connection options

```yaml
observability:
  victoriaLogs:
    url: https://victorialogs.example.com
    accountId: "12"
    projectId: "3"
    auth:
      existingSecret: victorialogs-readonly
      authorizationKey: authorization
```

Account and project IDs are optional unsigned 32-bit integers sent as `AccountID`
and `ProjectID` headers. Omit them to use the server's default tenant. They are
operator configuration; tool calls cannot change tenants or credentials.

If authentication is required, provision the named Secret in the release namespace
with the complete Authorization header in its `authorization` key, using your
secret-management workflow. The chart exposes that value only through an
environment variable. Use a proxy credential restricted to read-only query APIs.
Do not put credentials in the URL or values file. Omit the Secret setting for
an endpoint that does not require authentication.

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

To verify, configure the endpoint and ask the agent to discover fields, inspect
a discovered field's values, and retrieve a few matching logs. Confirm the source,
time range, and original fields in the result. An empty URL leaves the tools
unregistered. Apply configuration changes with a Helm upgrade.

See the upstream [VictoriaLogs query API](https://docs.victoriametrics.com/victorialogs/querying/)
and [LogsQL reference](https://docs.victoriametrics.com/victorialogs/logsql/).
