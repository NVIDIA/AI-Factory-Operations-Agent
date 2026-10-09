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

Connection behavior:

- Use HTTPS for remote endpoints. Internal HTTP service URLs are supported.
- Redirects are rejected; configure the endpoint directly.
- `tenantId` supplies the `X-Scope-OrgID` header. It does not replace authentication.
- An empty `observability.loki.url` disables log queries. Apply connection changes
  with a Helm upgrade.
