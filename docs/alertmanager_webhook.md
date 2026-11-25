<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Alertmanager webhook delivery

Enable `alertmanagerWebhook.enabled` to receive Alertmanager's
standard version 4 webhook notifications. This optional adapter converts each
firing alert into a Mosaic alert and removes resolved alerts from the Mosaic list.
It is disabled by default and uses the Node runtime already present in the
configured `mosaicUi.image`; no additional image or npm package is required.

## What each part does

```text
Prometheus rules
  -> Alertmanager routing, grouping, silences, inhibition, notification timing
  -> POST /api/alertmanager/webhook + independent bearer token
  -> mosaic-alertmanager-webhook
       firing: POST /api/alerts, id=alertmanager:<fingerprint>
       resolved: DELETE /api/alerts?id=alertmanager:<fingerprint>
  -> Mosaic UI alert store and event stream
  -> open browser with Auto investigate enabled
  -> server-side OpenClaw read-only investigation
```

The browser's **Auto investigate** switch starts investigations when its page code
receives alert events. The model and diagnostic tools execute on the server, but
the initial trigger is in the browser. Closing the page stops those new triggers.
This adapter does not provide an unattended investigation worker or proactive
Teams delivery. The separate cluster-monitor service performs its configured
periodic checks independently of this webhook.

**Auto pull** is the existing server-side polling switch: it reads active alerts
from the configured Alertmanager `/api/v2/alerts`. It is separate from **Auto
investigate**. When using webhook delivery, turn **Auto pull off**. Polling can
otherwise reinsert an alert that the webhook just removed, and it has different
selection semantics: webhook notifications follow Alertmanager's routes, silences,
inhibition, and notification timing.

| Responsibility | Who performs it |
| --- | --- |
| Create an independent inbound token Secret | Mosaic/monitoring administrator |
| Install/enable the adapter and permit network access | Mosaic administrator |
| Configure the Alertmanager receiver, route, and token file mount | Alertmanager administrator |
| Provide DNS, a certificate, and an ingress controller for cross-cluster HTTPS | Platform administrator, when needed |
| Validate delivery and decide which alerts to route | Monitoring and Mosaic administrators |
| Open the UI and enable Auto investigate for browser-triggered analysis | Mosaic user |
| Provision a Teams Bot/channel and configure notification delivery | Separate Teams integration; not performed by this adapter |

There is no Alertmanager subscription-registration API used here. Installing the
chart does not edit another Helm release, an Alertmanager Secret, or an
`AlertmanagerConfig` object.

## 1. Create a dedicated inbound credential

Run this Bash example against the intended Kubernetes context. The example puts
Mosaic in `mosaic` and Alertmanager in `prometheus`; change the namespaces for your
installation. The two Secrets contain the **same inbound credential**, while the
existing Mosaic UI machine token remains separate and is never given to
Alertmanager. Keep shell tracing disabled.

```bash
set -euo pipefail
umask 077
webhook_workdir="$(mktemp -d)"
trap 'rm -rf "$webhook_workdir"' EXIT
openssl rand -hex 32 | tr -d '\n' > "$webhook_workdir/token"

kubectl -n mosaic create secret generic mosaic-alertmanager-inbound \
  --from-file=token="$webhook_workdir/token"

kubectl -n prometheus create secret generic mosaic-alertmanager-inbound \
  --from-file=token="$webhook_workdir/token"
```

The receiver refuses to start with missing credentials, fewer than 32 nonblank
characters, newline characters, or identical inbound/UI tokens. Kubernetes Secret
references are used instead of literal tokens in Helm values. For separate
clusters, provision the matching inbound credential in each cluster through your
approved secret-management workflow; the two `kubectl` commands above assume one
cluster.

## 2. Enable the receiver

Add this to your Mosaic values overlay, then apply it with your existing release
values and chart version. The default Service is internal to the cluster.

```yaml
alertmanagerWebhook:
  enabled: true
  auth:
    existingSecret: mosaic-alertmanager-inbound
    tokenKey: token
```

For an existing release, use a chart containing this feature. Helm 3.14 or later
supports `--reset-then-reuse-values`, which applies new chart defaults before
reusing the release's saved values and your overlay:

```bash
helm upgrade mosaic "$MOSAIC_CHART" \
  --devel -n mosaic --reset-then-reuse-values \
  -f alertmanager-webhook-values.yaml \
  --wait --timeout 12m

kubectl -n mosaic rollout status deployment/mosaic-alertmanager-webhook
```

The adapter reads `machineToken` from the same Secret as the UI:
`mosaicUi.auth.existingSecret`, or `mosaicUi.auth.name` when the chart manages it.
It runs as UID/GID 1000 with a read-only root filesystem, dropped capabilities,
and no Kubernetes service-account token. The chart requires both UI switches to
be enabled and `mosaicUi.replicaCount=1`, because the UI alert store is
process-local. The receiver itself has one replica and no persistent queue.

For Alertmanager outside the cluster, configure a reachable HTTPS ingress and
allow only the required source networks in your platform ingress/firewall policy:

```yaml
alertmanagerWebhook:
  enabled: true
  auth:
    existingSecret: mosaic-alertmanager-inbound
  ingress:
    enabled: true
    className: nginx
    host: mosaic-alerts.example.com
    tlsSecretName: mosaic-alerts-tls
```

The chart exposes only the exact `/api/alertmanager/webhook` path and requires
both a host and TLS Secret name. It does not expose the UI API or create the
ingress controller/certificate. Preserve certificate verification on Alertmanager;
configure its trusted CA if using an internal CA. Use a trusted network or a TLS
proxy for the internal HTTP Service. The inbound bearer token allows injection
and removal of Mosaic alerts, so restrict its distribution.

## 3. Configure Alertmanager

Mount the inbound Secret into the Alertmanager container. With Prometheus
Operator, add `mosaic-alertmanager-inbound` to the Alertmanager resource's
`spec.secrets` list **while retaining existing entries**. The token file is then:

```text
/etc/alertmanager/secrets/mosaic-alertmanager-inbound/token
```

For an independently managed Alertmanager, mount the token at a path of your
choice and update `credentials_file` below. Do not use the Mosaic UI machine token.

Add this named receiver to the existing `receivers` list:

```yaml
receivers:
  - name: mosaic-webhook
    webhook_configs:
      - url: http://mosaic-alertmanager-webhook.mosaic.svc.cluster.local:3004/api/alertmanager/webhook
        send_resolved: true
        max_alerts: 0
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/secrets/mosaic-alertmanager-inbound/token
```

For the HTTPS ingress example, replace `url` with:

```text
https://mosaic-alerts.example.com/api/alertmanager/webhook
```

Insert a child route for the desired alert labels **before existing sibling
routes**, retaining your current root receiver, other routes, and other receivers:

```yaml
routes:
  - receiver: mosaic-webhook
    matchers:
      - 'severity=~"warning|critical"'
    group_by: ['alertname', 'cluster']
    group_wait: 10s
    group_interval: 1m
    repeat_interval: 4h
    continue: true
```

These are fragments for your existing configuration, not a replacement
`alertmanager.yml`. `continue: true` permits evaluation of later sibling routes;
review the effective route tree to preserve existing notification destinations.
An earlier matching sibling with `continue: false` prevents later routes from
receiving that alert. Root-receiver fallback also depends on whether a child
matched; add an explicit sibling route for any destination that must receive the
same alerts. Use `amtool check-config` and `amtool config routes test` for your
installed Alertmanager version before deploying the merged configuration.

The receiver accepts the standard version 4 JSON shape. Do not configure a custom
webhook payload. `send_resolved: true` is required to clear resolved alerts from
the Mosaic list. `max_alerts: 0` prevents Alertmanager from omitting alerts from
a notification; a nonzero `truncatedAlerts` count is rejected with HTTP 422.

## Delivery behavior and limits

| Condition | Behavior |
| --- | --- |
| Firing alert | Upsert using `alertmanager:<fingerprint>`, matching the polling ID |
| Repeated firing alert or retried group | Same ID is updated; the existing UI investigation stage is retained |
| Mixed firing/resolved group | Each alert's own status is used, independently of the group's status |
| Resolved alert | Remove that ID from the Mosaic list; repeat removal is successful even when absent |
| Full labels and annotations | Forwarded without truncation; the human-readable `payload` field is limited to 1000 characters |
| Missing/wrong bearer token | HTTP 401; no downstream request |
| Wrong method/path/content type | HTTP 405/404/415 respectively |
| Invalid JSON/schema or more than 1000 alerts | HTTP 400; validate the entire group before sending anything |
| Truncated Alertmanager notification | HTTP 422; change Alertmanager to `max_alerts: 0` |
| Body over 1 MiB, including chunked bodies | HTTP 413 |
| Another group currently processing | HTTP 503; one active group bounds receiver work |
| Downstream error, redirect, non-JSON response, `success:false`, or suppression | HTTP 502 |
| Downstream timeout | HTTP 502 after a shared 15-second budget for the group |
| All alerts accepted | HTTP 200 with `{ "success": true, "firing": N, "resolved": M }` |
| Health probe | `GET /healthz` reports receiver process health; it does not prove UI delivery |

Alertmanager can retry 5xx responses. A group can partially reach Mosaic before
a downstream failure; retrying repeats idempotent upserts/removals. This is not
an atomic transaction or exactly-once delivery. If group processing regularly
exceeds the time/body limits, split notifications with suitable `group_by` labels;
do not truncate them with `max_alerts`. Do not disable Alertmanager retry handling
in an intermediate proxy. The receiver refuses outbound redirects to avoid
forwarding its UI credential to another destination.

There is no durable queue, alert history, resolved tombstone, or reconciliation
worker in the adapter. The UI holds at most 200 recent alerts in process memory;
restarts clear that list and its investigation stages. An active alert may only
reappear on a later Alertmanager notification/repeat. A delayed firing delivery
can recreate a previously resolved entry; different Alertmanager HA replicas can
deliver duplicates or out of order. Reusing a fingerprint for a new occurrence
while its older entry remains also retains that entry's stage. These limits do
not establish incident lifecycle guarantees. Use your monitoring system as the
authoritative alert history.

Removing an entry does not cancel an already running investigation, silence an
upstream alert, or repair a fault. Marking a Mosaic investigation completed also
does not mean the underlying fault was resolved. Automatic investigation sessions
remain subject to Mosaic's [read-only automation guard](security_model.md).

After rotating either existing Secret, restart the receiver Deployment to reload
its environment. Rotate the inbound token in Alertmanager at the same time;
restart/reload that client as required by your deployment. Never publish tokens
or private alert labels/annotations in a support issue.

## Verify delivery

1. Verify the receiver Deployment is Ready and the Alertmanager configuration
   loaded successfully. In Mosaic, turn **Auto pull off** to isolate push delivery.
2. Send a synthetic alert through the **real Alertmanager**, using a label matched
   by your Mosaic route. The following example creates a warning that expires
   after 10 minutes. Set `ALERTMANAGER_URL` to an administrator-reachable endpoint
   and supply its required authentication/TLS options to `curl`.

   ```bash
   python3 - <<'PY' > /tmp/mosaic-webhook-test.json
   import datetime, json
   now = datetime.datetime.now(datetime.timezone.utc)
   stamp = lambda t: t.isoformat().replace('+00:00', 'Z')
   print(json.dumps([{
       'labels': {'alertname': 'MosaicWebhookSmokeTest', 'severity': 'warning',
                  'cluster': 'webhook-smoke-test'},
       'annotations': {'summary': 'Synthetic delivery test; no cluster fault'},
       'startsAt': stamp(now),
       'endsAt': stamp(now + datetime.timedelta(minutes=10)),
       'generatorURL': 'https://example.com/mosaic-webhook-test'
   }]))
   PY

   curl --fail-with-body \
     -H 'Content-Type: application/json' \
     --data-binary @/tmp/mosaic-webhook-test.json \
     "${ALERTMANAGER_URL%/}/api/v2/alerts"
   ```

3. After the configured `group_wait`, check Mosaic's alert list for
   `MosaicWebhookSmokeTest`. Check Alertmanager's receiver delivery metrics/logs
   and any ingress logs for successful HTTP delivery. An ingestion API success
   alone does not prove Alertmanager routing, network access, or real delivery.
4. Repeat the same synthetic POST before it expires. Verify the fingerprint
   identifies a single Mosaic entry. Alertmanager may wait for the configured
   notification interval before resending.
5. Resolve the test explicitly using the same labels and original `startsAt`:

   ```bash
   python3 - <<'PY'
   import datetime, json
   from pathlib import Path
   path = Path('/tmp/mosaic-webhook-test.json')
   alerts = json.loads(path.read_text())
   alerts[0]['endsAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
   path.write_text(json.dumps(alerts))
   PY

   curl --fail-with-body \
     -H 'Content-Type: application/json' \
     --data-binary @/tmp/mosaic-webhook-test.json \
     "${ALERTMANAGER_URL%/}/api/v2/alerts"

   rm /tmp/mosaic-webhook-test.json
   ```

6. After the next notification interval, verify the Mosaic entry disappears and
   Alertmanager shows the synthetic alert resolved. If testing investigation too,
   keep the Mosaic page open, enable **Auto investigate**, and separately verify
   an automation investigation session and a completed analysis. Closing that
   browser does not test unattended investigation; this adapter does not add it.

## Developer validation

With the chart test dependencies prepared as in CI:

```bash
node --test helm/mosaic-stack/tests/alertmanager-webhook*.test.mjs
helm lint helm/mosaic-stack
```

The HTTP integration tests use a local fake Mosaic API. They cover normalization,
metadata preservation, grouped status handling, repeated delivery, resolution,
credentials, input limits, partial failure and retry, rejected downstream
responses, timeouts, and backpressure. Helm tests cover default-off behavior,
packaged source, Secret references, TLS ingress scope, and invalid configurations.
To exercise an installed Alertmanager binary against the adapter and fake Mosaic
API, run:

```bash
ALERTMANAGER_BINARY=/path/to/alertmanager \
  node --test helm/mosaic-stack/tests/alertmanager-webhook.test.mjs
```

This optional test starts an isolated Alertmanager, configures its token file and
receiver, submits two synthetic alerts through `/api/v2/alerts`, and verifies both
firing delivery and per-alert resolution. It does not contact a deployed cluster
or verify the private UI image. These tests do not replace the deployment smoke
test above.

The protocol and configuration are described in the official
[Alertmanager webhook reference](https://prometheus.io/docs/alerting/latest/configuration/#webhook_config).
The Secret mount path is defined by the
[Prometheus Operator API](https://prometheus-operator.dev/docs/api-reference/api/#monitoring.coreos.com/v1.AlertmanagerSpec).
