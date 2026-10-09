# Loki query reference

For connection setup and verification, see [Read-only Loki logs](installation.md#read-only-loki-logs).

## Connection options

If Loki requires authentication, provision a Secret in Mosaic's namespace using
your secret-management process:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: loki-readonly
  namespace: mosaic
type: Opaque
stringData:
  authorization: "Bearer <your-read-only-token>"
```

For basic authentication, use `Basic <base64(username:password)>` instead.
Keep credentials out of Helm values and source control.

Add these options to the installation command, replacing the Secret name and
tenant ID with your values:

```bash
--set-string observability.loki.auth.existingSecret=loki-readonly \
--set-string observability.loki.tenantId=your-tenant-id
```

Omit the Secret option if authentication is not required, and omit the tenant
option if your Loki service does not require a tenant ID. The Secret's default
key is `authorization`; use `observability.loki.auth.authorizationKey` if yours
differs. The Secret must exist in the release namespace before upgrading.

## Queries and limits

Mosaic can discover labels and query log streams in View mode. Ask for a source
and time range in natural language; you do not need to call the tools yourself.

| Operation | Tool |
| --- | --- |
| Discover label names or values | `observability_log_labels` |
| Query log streams or numeric LogQL results | `observability_logs` |

Use metric LogQL expressions for counts, rates, and aggregations. For a total over
an incident window, request an instant evaluation with the lookback in the expression,
such as `sum(count_over_time({service="worker"}[15m]))`. For a trend, use a range
query, such as `sum(rate({service="worker"}[5m]))`, with `start`, `end`, and optional
`step` in seconds. Replace example labels with discovered source labels.

`mode: "instant"` evaluates once at `end` (default now); omit `start` and `step`.
The default `mode: "range"` evaluates across the requested time window. Numeric
results retain Loki's labels, timestamps, and sample values. The entry limit applies
to log lines, not numeric results; response-size and timeout limits apply to both.
Count matching logs with an aggregation rather than estimating from a capped list
of returned entries. Counts describe the selected logs and their timestamps, not
necessarily the rate at which Loki received them.

| Query setting | Default | Maximum |
| --- | --- | --- |
| Range query time window | Past hour | 24 hours |
| Returned entries | 100 | 1,000 |
| Upstream response size | — | 2 MiB |
| Request duration | — | 15 seconds |

If a query reaches a limit, narrow the source labels or time window.

Connection behavior:

- Use HTTPS for remote endpoints. Internal HTTP service URLs are supported.
- Redirects are rejected; configure the endpoint directly.
- `tenantId` supplies the `X-Scope-OrgID` header. It does not replace authentication.
- The Authorization Secret is supplied to OpenClaw, not the UI or agent sandbox.
- An empty `observability.loki.url` disables log queries. Apply connection changes
  with a Helm upgrade.
