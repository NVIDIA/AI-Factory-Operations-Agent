// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  AlertService,
  Store,
  normalizeConfig,
  incidentKey,
  sha256,
  requestJson,
  completedReport,
  save,
} from "../files/openclaw-seed/extensions/alert-automation/core.ts";
import {
  nativeRuntime,
  reportChunks,
} from "../files/openclaw-seed/extensions/alert-automation/runtime.ts";
import { registerAlertAutomation } from "../files/openclaw-seed/extensions/alert-automation/plugin.ts";

function config(overrides = {}) {
  return normalizeConfig({
    sourceMode: "poll",
    alertmanagerUrl: "http://127.0.0.1:9093",
    matchLabels: { test: "yes" },
    delivery: {
      channel: "slack",
      target: "channel:C_TEST",
      sessionKey: "agent:default:slack:channel:c_test",
    },
    ...overrides,
  });
}
function alert(overrides = {}) {
  return {
    fingerprint: "1234567890abcdef",
    startsAt: "2026-11-02T12:00:00.000Z",
    status: { state: "active", silencedBy: [], inhibitedBy: [] },
    labels: { test: "yes", run_id: "plugin-unit-run", alertname: "TestAlert" },
    annotations: { description: "Unit fixture" },
    ...overrides,
  };
}
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), "mosaic-alert-plugin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const logger = { info() {}, error() {} };
function runtime(overrides = {}) {
  let prompt = "";
  let runs = 0,
    sends = 0;
  return {
    async run(params) {
      runs++;
      prompt = params.message;
      return { runId: "native-test-run" };
    },
    async wait() {
      return { status: "ok" };
    },
    async history() {
      return {
        messages: [
          { role: "user", content: prompt },
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                name: "observability_query",
                arguments: { query: "actual" },
              },
            ],
          },
          {
            role: "toolResult",
            toolName: "observability_query",
            content: [{ type: "text", text: "95" }],
          },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Observed 95. Host logs remain uncollected.",
              },
            ],
            stopReason: "stop",
          },
        ],
      };
    },
    async deliver(params, save) {
      sends++;
      save("test-published.json", { report: params.report });
      return { messageIds: ["native-message-id"] };
    },
    counters() {
      return { runs, sends };
    },
    ...overrides,
  };
}
async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => s.close(resolve)));
  return `http://127.0.0.1:${s.address().port}`;
}

test("configures native channel and Agent independently without Feishu-specific identifiers", () => {
  for (const [channel, target, sessionKey] of [
    ["feishu", "chat:oc_test", "agent:expert:feishu:direct:ou_test"],
    ["msteams", "conversation:test", "agent:expert:msteams:direct:test"],
    ["slack", "channel:C123", "agent:expert:slack:channel:c123"],
  ]) {
    const cfg = config({
      agentId: "expert",
      matchLabels: {},
      delivery: { channel, target, sessionKey },
    });
    assert.equal(cfg.delivery.channel, channel);
    assert.equal(cfg.agentId, "expert");
    assert.deepEqual(cfg.matchLabels, {});
  }
  assert.throws(
    () =>
      config({
        delivery: {
          channel: "slack",
          target: "x",
          sessionKey: "agent:other:slack:direct:x",
        },
      }),
    /selected Agent/,
  );
  assert.throws(() => config({ stateDirectory: "../outside" }), /directory/);
  assert.throws(
    () => config({ alertmanagerUrl: "https://user:secret@example.com" }),
    /Invalid/,
  );
  assert.throws(
    () => config({ alertmanagerUrl: "file:///tmp/test" }),
    /Invalid/,
  );
  assert.throws(
    () => config({ sourceMode: "webhook" }),
    /dedicated bearer token/,
  );
});

function render(...args) {
  return execFileSync(
    "helm",
    [
      "template",
      "mosaic",
      fileURLToPath(new URL("..", import.meta.url)),
      "--namespace",
      "mosaic",
      ...args,
    ],
    { encoding: "utf8" },
  );
}
function pluginRender(...args) {
  return render(
    "--set",
    "modules.alertAutomation.enabled=true",
    "--set",
    "modules.alertAutomation.delivery.channel=slack",
    "--set",
    "modules.alertAutomation.delivery.target=channel:C_TEST",
    "--set",
    "modules.alertAutomation.delivery.sessionKey=agent:default:slack:channel:c_test",
    ...args,
  );
}
test("Helm installs the optional service with no host Python or systemd dependency", () => {
  const disabled = render(
    "--show-only",
    "templates/openclaw-seed-configmap.yaml",
  );
  assert.doesNotMatch(disabled, /alert-automation\.index\.ts:/);
  const enabled = pluginRender(
    "--show-only",
    "templates/openclaw-seed-configmap.yaml",
  );
  for (const name of [
    "index.ts",
    "plugin.ts",
    "core.ts",
    "runtime.ts",
    "openclaw.plugin.json",
    "package.json",
  ])
    assert.ok(enabled.includes(`alert-automation.${name}: |-`));
  assert.match(enabled, /"sourceMode": "poll"/);
  assert.match(enabled, /"channel": "slack"/);
  assert.match(enabled, /"allowConversationAccess": true/);
  const deploy = pluginRender("--show-only", "templates/openclaw.yaml");
  assert.match(deploy, /cp \/seed\/alert-automation\.core\.ts/);
  assert.match(deploy, /claimName: openclaw-home-pvc/);
  assert.doesNotMatch(deploy, /mosaic-alert-worker\.py|systemctl/);
});
test("Helm requires webhook credentials and references Kubernetes Secrets", () => {
  assert.throws(
    () => pluginRender("--set", "modules.alertAutomation.sourceMode=webhook"),
    /webhook.existingSecret/,
  );
  const deploy = pluginRender(
    "--set",
    "modules.alertAutomation.sourceMode=both",
    "--set",
    "modules.alertAutomation.webhook.existingSecret=alert-webhook-auth",
    "--set",
    "modules.alertAutomation.alertmanagerAuth.existingSecret=alertmanager-auth",
    "--show-only",
    "templates/openclaw.yaml",
  );
  assert.match(
    deploy,
    /name: MOSAIC_ALERT_WEBHOOK_TOKEN[\s\S]*name: "alert-webhook-auth"/,
  );
  assert.match(
    deploy,
    /name: MOSAIC_ALERTMANAGER_TOKEN[\s\S]*name: "alertmanager-auth"/,
  );
  assert.throws(
    () => pluginRender("--set", "openclaw.enabled=false"),
    /requires OpenClaw execution/,
  );
});

test("baselines existing alerts, then persists a new occurrence across restart", (t) => {
  const root = directory(t),
    cfg = config();
  let store = new Store(root);
  const first = alert(),
    second = alert({ startsAt: "2026-11-02T12:01:00.000Z" });
  store.ingest([first], cfg, {
    snapshot: true,
    presentKeys: new Set([incidentKey(first)]),
    baseline: true,
  });
  assert.equal(store.get(incidentKey(first)).state, "ignored_existing");
  store.ingest([second], cfg, {
    snapshot: true,
    presentKeys: new Set([incidentKey(second)]),
  });
  assert.equal(store.pending().length, 1);
  store.change(incidentKey(second), "sent", { messageId: "platform-id" });
  store.close();
  store = new Store(root);
  store.ingest([second], cfg, {
    snapshot: true,
    presentKeys: new Set([incidentKey(second)]),
  });
  assert.equal(store.pending().length, 0);
  assert.equal(store.get(incidentKey(second)).message_id, "platform-id");
  assert.equal(store.rows().length, 2);
  store.close();
});

test("retains the actual legacy Python ledger without replaying sent incidents", (t) => {
  const root = directory(t);
  const worker = fileURLToPath(
    new URL("../../../utils/mosaic-alert-worker.py", import.meta.url),
  );
  execFileSync("python3", [
    "-c",
    `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('worker',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
s=m.Store(sys.argv[2]);a=json.loads(sys.argv[3]);s.ingest([a],include_existing=True);s.change(m.incident_key(a),'sent',message_id='legacy-platform-id')
`,
    worker,
    root,
    JSON.stringify(alert()),
  ]);
  const store = new Store(root);
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows()[0].message_id, "legacy-platform-id");
  assert.equal(store.pending().length, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 1);
  store.close();
});

test("rolls back an over-capacity batch, preserving all intake for a later retry", (t) => {
  const store = new Store(directory(t));
  const cfg = config({ maxPending: 1 });
  assert.throws(
    () =>
      store.ingest([alert(), alert({ fingerprint: "abcdef1234567890" })], cfg),
    /capacity/,
  );
  assert.equal(store.rows().length, 0);
  store.close();
});

test("recipient child threads inherit report context without leaking it to another peer", (t) => {
  const store = new Store(directory(t));
  const a = alert();
  const cfg = config();
  store.ingest([a], cfg);
  const id = incidentKey(a);
  const report = "Complete context for this recipient only";
  const folder = join(store.directory(id));
  store.bindReport(
    id,
    "agent:default:feishu:direct:ou_person",
    "run-thread-test",
    report,
  );
  const fs = process.getBuiltinModule("node:fs");
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(join(folder, "published-report.txt"), report);
  assert.equal(
    store.reportContext(
      "agent:default:feishu:direct:ou_person:thread:om_report",
    ).report,
    report,
  );
  assert.equal(
    store.reportContext("agent:default:feishu:direct:ou_person2"),
    undefined,
  );
  assert.equal(
    store.reportContext("agent:other:feishu:direct:ou_person"),
    undefined,
  );
  assert.equal(
    store.reportContext("agent:default:slack:direct:ou_person"),
    undefined,
  );
  store.close();
});

test("one native Agent goal produces the complete unchanged model report and durable followup context", async (t) => {
  const root = directory(t),
    a = alert(),
    rt = runtime();
  const service = new AlertService(config(), root, rt, logger, {});
  service.store.ingest([a], service.config);
  await service.process(incidentKey(a));
  assert.deepEqual(rt.counters(), { runs: 1, sends: 1 });
  assert.equal(service.store.get(incidentKey(a)).state, "sent");
  const request = JSON.parse(
    readFileSync(
      join(root, "incidents", incidentKey(a), "investigation.request.json"),
    ),
  );
  assert.equal(request.deliver, false);
  assert.match(request.sessionKey, /mosaic-automation-alert-/);
  assert.doesNotMatch(
    request.message,
    /telemetry, nvml-witness|mosaic-gpu-validation-20261031/,
  );
  const report = readFileSync(
    join(root, "incidents", incidentKey(a), "model-report.txt"),
    "utf8",
  );
  assert.equal(report, "Observed 95. Host logs remain uncollected.");
  const binding = service.store.reportContext(
    service.config.delivery.sessionKey,
  );
  assert.ok(binding.report.includes(report));
  assert.equal(binding.report_sha256, sha256(binding.report));
  service.stop();
  const reopened = new Store(root);
  assert.equal(
    reopened.reportContext(service.config.delivery.sessionKey).report,
    binding.report,
  );
  reopened.close();
});

test("a native investigation failure is retained and is not repeated after restart", async (t) => {
  const root = directory(t),
    a = alert(),
    rt = runtime({
      async wait() {
        return { status: "timeout" };
      },
    });
  let service = new AlertService(config(), root, rt, logger, {});
  service.store.ingest([a], service.config);
  await service.process(incidentKey(a));
  assert.equal(service.store.get(incidentKey(a)).state, "needs_attention");
  service.stop();
  service = new AlertService(config(), root, rt, logger, {});
  assert.equal(service.store.pending().length, 0);
  assert.deepEqual(rt.counters(), { runs: 1, sends: 0 });
  service.stop();
});

test("uncertain and interrupted sends are not blindly replayed", async (t) => {
  const root = directory(t),
    a = alert();
  let attempts = 0;
  const rt = runtime({
    async deliver() {
      attempts++;
      throw new Error("Connection lost after platform side effect");
    },
  });
  let service = new AlertService(config(), root, rt, logger, {});
  service.store.ingest([a], service.config);
  await service.process(incidentKey(a));
  assert.equal(service.store.get(incidentKey(a)).state, "delivery_unknown");
  service.stop();
  service = new AlertService(config(), root, rt, logger, {});
  assert.equal(service.store.pending().length, 0);
  assert.equal(attempts, 1);
  service.store.change(incidentKey(a), "sending");
  await service.process(incidentKey(a));
  assert.equal(service.store.get(incidentKey(a)).state, "delivery_unknown");
  assert.equal(attempts, 1);
  service.stop();
});

test("reconciles an interrupted investigation with history instead of starting another Agent run", async (t) => {
  const root = directory(t),
    a = alert(),
    rt = runtime();
  const service = new AlertService(config(), root, rt, logger, {});
  service.store.ingest([a], service.config);
  service.store.change(incidentKey(a), "investigating");
  await service.process(incidentKey(a));
  assert.equal(service.store.get(incidentKey(a)).state, "needs_attention");
  assert.deepEqual(rt.counters(), { runs: 0, sends: 0 });
  service.stop();
});

test("validates a complete final answer rather than an intermediate tool turn", () => {
  assert.throws(
    () =>
      completedReport(
        [
          { role: "user", content: "p" },
          {
            role: "assistant",
            stopReason: "toolUse",
            content: [{ type: "toolCall" }],
          },
        ],
        "p",
      ),
    /normal final/,
  );
  assert.throws(
    () =>
      completedReport(
        [
          { role: "user", content: "other" },
          { role: "assistant", content: "answer" },
        ],
        "expected",
      ),
    /associated/,
  );
  assert.throws(
    () =>
      completedReport(
        [
          { role: "user", content: "p" },
          { role: "assistant", content: "cut", stopReason: "length" },
        ],
        "p",
      ),
    /normal final/,
  );
});

test("exact chunking preserves all Unicode, whitespace and final characters", () => {
  const text = " start\n" + "中文🚀e\u0301  \n".repeat(1100) + "THE END\n";
  const chunks = reportChunks(text, 123, 400);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.length > 20);
  for (const chunk of chunks) {
    assert.ok([...chunk].length <= 123);
    assert.ok(Buffer.byteLength(chunk) <= 400);
  }
});

test("native delivery uses the configured channel and records every complete report part", async () => {
  const sent = [],
    records = new Map();
  let requestedChannel;
  const rt = nativeRuntime({
    config: {},
    runtime: {
      subagent: {},
      channel: {
        outbound: {
          async loadAdapter(channel) {
            requestedChannel = channel;
            return {
              textChunkLimit: 80,
              async sendText(params) {
                sent.push(params);
                return { channel, messageId: `part-${sent.length}` };
              },
            };
          },
        },
      },
    },
  });
  const report = "Full 模型报告\n".repeat(100);
  const delivery = {
    channel: "msteams",
    target: "conversation:fixture",
    sessionKey: "agent:expert:msteams:direct:fixture",
    accountId: "a",
  };
  const receipt = await rt.deliver(
    {
      delivery,
      report,
      incidentId: "incident",
      idempotencyKey: "key",
      signal: new AbortController().signal,
    },
    (k, v) => records.set(k, v),
  );
  assert.equal(requestedChannel, "msteams");
  assert.equal(sent.map((p) => p.text).join(""), report);
  assert.ok(sent.every((p) => p.to === delivery.target && p.accountId === "a"));
  assert.equal(receipt.messageIds.length, sent.length);
  assert.equal(
    records.get("native-delivery.progress.json").completedParts,
    sent.length,
  );
});

test("native delivery stops before the next part when shutdown interrupts a send", async () => {
  const controller = new AbortController();
  let calls = 0;
  const rt = nativeRuntime({
    config: {},
    runtime: {
      channel: {
        outbound: {
          async loadAdapter() {
            return {
              textChunkLimit: 10,
              async sendText() {
                calls++;
                controller.abort();
                return { messageId: "first" };
              },
            };
          },
        },
      },
    },
  });
  await assert.rejects(
    rt.deliver(
      {
        delivery: { channel: "slack", target: "t", sessionKey: "s" },
        report: "x".repeat(40),
        incidentId: "i",
        idempotencyKey: "k",
        signal: controller.signal,
      },
      () => {},
    ),
  );
  assert.equal(calls, 1);
});

test("HTTP transport records complete responses but never follows a credential-bearing redirect", async (t) => {
  const root = directory(t);
  let destinationRequests = 0;
  const target = await server(t, (_req, res) => {
    destinationRequests++;
    res.end("{}");
  });
  const origin = await server(t, (_req, res) => {
    res.statusCode = 302;
    res.setHeader("location", target + "/stolen");
    res.end("{}");
  });
  await assert.rejects(
    requestJson(origin, "/alerts", {
      token: "unit-only-not-a-real-secret",
      evidence: join(root, "request"),
    }),
    /HTTP 302/,
  );
  assert.equal(destinationRequests, 0);
  assert.doesNotMatch(
    readFileSync(join(root, "request.request.json"), "utf8"),
    /unit-only/,
  );
});

test("native plugin owns webhook jobs independently of HTTP scope and restores report context", async (t) => {
  const root = directory(t),
    token = "unit-test-webhook-bearer-token-only";
  const requestScope = new AsyncLocalStorage();
  const previous = process.env.MOSAIC_ALERT_WEBHOOK_TOKEN;
  process.env.MOSAIC_ALERT_WEBHOOK_TOKEN = token;
  t.after(() => {
    if (previous === undefined) delete process.env.MOSAIC_ALERT_WEBHOOK_TOKEN;
    else process.env.MOSAIC_ALERT_WEBHOOK_TOKEN = previous;
  });
  let lifecycle, route, hook;
  const messages = [];
  let prompt;
  const api = {
    pluginConfig: {
      sourceMode: "webhook",
      delivery: {
        channel: "slack",
        target: "channel:C_TEST",
        sessionKey: "agent:default:slack:channel:c_test",
      },
    },
    config: { agents: { list: [{ id: "default" }] } },
    logger,
    registerService(value) {
      lifecycle = value;
    },
    registerHttpRoute(value) {
      route = value;
    },
    registerGatewayMethod() {},
    on(name, handler) {
      assert.equal(name, "before_prompt_build");
      hook = handler;
    },
    runtime: {
      subagent: {
        async run(p) {
          if (requestScope.getStore()?.httpClient)
            throw new Error("missing scope: operator.write");
          prompt = p.message;
          return { runId: "native" };
        },
        async waitForRun() {
          return { status: "ok" };
        },
        async getSessionMessages() {
          return {
            messages: [
              { role: "user", content: prompt },
              {
                role: "assistant",
                content: "FULL REPORT 🧪",
                stopReason: "stop",
              },
            ],
          };
        },
      },
      channel: {
        outbound: {
          async loadAdapter() {
            return {
              async sendText(p) {
                messages.push(p.text);
                return { messageId: "real-adapter-fixture-id" };
              },
            };
          },
        },
      },
    },
  };
  registerAlertAutomation(api);
  lifecycle.start({ stateDir: root, config: api.config, logger });
  t.after(() => lifecycle.stop());
  const endpoint = await server(t, (req, res) => {
    requestScope.run({ httpClient: true, scopes: [] }, () => {
      void route.handler(req, res);
    });
  });
  const body = JSON.stringify({ alerts: [alert({ status: "firing" })] });
  const response = await fetch(endpoint + route.path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  assert.equal(response.status, 401);
  assert.equal(messages.length, 0);
  const accepted = await fetch(endpoint + route.path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
    },
    body,
  });
  assert.equal(accepted.status, 202);
  for (let i = 0; i < 100 && !messages.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(messages.length, 1);
  for (let turn = 0; turn < 2; turn++)
    assert.ok(
      hook(
        { prompt: "Summarize the report" },
        {
          sessionKey: api.pluginConfig.delivery.sessionKey,
          runId: `followup-${turn}`,
        },
      ).prependContext.includes("FULL REPORT 🧪"),
    );
  lifecycle.stop();
  lifecycle.start({ stateDir: root, config: api.config, logger });
  assert.ok(
    hook(
      { prompt: "What evidence is missing?" },
      {
        sessionKey: api.pluginConfig.delivery.sessionKey,
        runId: "after-restart",
      },
    ).prependContext.includes("FULL REPORT 🧪"),
  );
  const repeated = await fetch(endpoint + route.path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + token,
    },
    body,
  });
  assert.equal(repeated.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(messages.length, 1);
});

test("webhook-only recovery clears the imported UI alert without polling Alertmanager", async (t) => {
  const root = directory(t);
  let deleted = 0;
  const ui = await server(t, (req, res) => {
    if (req.method === "DELETE") {
      deleted++;
      assert.equal(
        req.url,
        "/api/alerts?id=alertmanager%3A1234567890abcdef",
      );
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ success: true }));
  });
  const env = {
    MOSAIC_ALERT_WEBHOOK_TOKEN: "test-only-webhook-token-not-a-real-credential",
    MOSAIC_UI_MACHINE_TOKEN: "test-only-ui-token",
  };
  const cfg = normalizeConfig({
    sourceMode: "webhook",
    mosaicUrl: ui,
    delivery: {
      channel: "slack",
      target: "channel:C_TEST",
      sessionKey: "agent:default:slack:channel:c_test",
    },
  }, env);
  const rt = runtime();
  const service = new AlertService(cfg, root, rt, logger, env);
  t.after(() => service.stop());
  service.start();
  const source = alert({ status: "firing" });
  service.ingestWebhook({ alerts: [source] });
  const id = incidentKey(source);
  for (let i = 0; i < 100 && service.store.get(id)?.state !== "sent"; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(service.store.get(id).state, "sent");
  service.ingestWebhook({ alerts: [{ ...source, status: "resolved" }] });
  for (let i = 0; i < 100 && !service.store.get(id)?.ui_cleared_at; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(service.store.get(id).resolved_at);
  assert.ok(service.store.get(id).ui_cleared_at);
  assert.equal(deleted, 1);
  assert.deepEqual(rt.counters(), { runs: 1, sends: 1 });
  assert.equal(existsSync(join(root, "last-poll.json")), false);
});

test("an agent-only hook registration reads the latest durable report without starting the Gateway service", (t) => {
  const root = directory(t);
  const cfg = config();
  const state = join(root, cfg.stateDirectory);
  const store = new Store(state);
  const source = alert();
  const id = incidentKey(source);
  store.ingest([source], cfg);
  const report =
    "FRESH REPORT: evidence belongs to fresh-report-run, not the old conversation.";
  // The real publisher has already persisted this file and binding.
  save(join(store.directory(id), "published-report.txt"), report);
  store.bindReport(id, cfg.delivery.sessionKey, "fresh-report-run", report);
  store.close();
  let hook;
  const api = {
    pluginConfig: { alertmanagerUrl: cfg.alertmanagerUrl, delivery: cfg.delivery },
    config: {},
    logger,
    runtime: { state: { resolveStateDir: () => root } },
    registerService() {},
    registerGatewayMethod() {},
    on(name, handler) {
      assert.equal(name, "before_prompt_build");
      hook = handler;
    },
  };
  registerAlertAutomation(api);
  // Native Agent hook registries do not run the Gateway service lifecycle.
  // Native channel turns can also omit ctx.runId.
  const result = hook(
    { prompt: "What is the report Run ID?" },
    { sessionKey: cfg.delivery.sessionKey },
  );
  assert.ok(result?.prependContext.includes(report));
  assert.ok(result.prependContext.includes("Run ID: fresh-report-run"));
  const paths = readdirSync(join(state, "incidents", id, "context-use"));
  assert.equal(paths.length, 1);
  const witness = JSON.parse(
    readFileSync(join(state, "incidents", id, "context-use", paths[0]), "utf8"),
  );
  assert.equal(witness.runId, null);
  assert.equal(witness.reportIncidentId, id);
  assert.equal(witness.inputPrompt, "What is the report Run ID?");
  assert.equal(witness.completeReportSha256, sha256(report));
  assert.equal(
    hook(
      { prompt: "Same Run ID?" },
      { sessionKey: "agent:other:slack:channel:c_test" },
    ),
    undefined,
  );
});
