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
| Retrieve timestamped log streams using a LogQL selector or pipeline | `observability_logs` |

The log tool does not support metric LogQL expressions such as `count_over_time`.
A limited set of returned log entries is not a measurement of total ingestion volume.

| Query setting | Default | Maximum |
| --- | --- | --- |
| Time window | Past hour | 24 hours |
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
