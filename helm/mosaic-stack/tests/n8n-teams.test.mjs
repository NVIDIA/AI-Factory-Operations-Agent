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
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  N8nBridge,
  teamsMessageText,
} from "../files/openclaw-seed/extensions/alert-automation/n8n.ts";
import {
  AlertService,
  normalizeConfig,
  Store,
  save,
  sha256,
  incidentKey,
} from "../files/openclaw-seed/extensions/alert-automation/core.ts";
import { registerAlertAutomation } from "../files/openclaw-seed/extensions/alert-automation/plugin.ts";
import {
  isReadonlyAutomationSession,
  contextAllowsEdit,
} from "../files/openclaw-seed/extensions/automation-context.ts";

const senderId = "11111111-1111-4111-8111-111111111111";
const recipientId = "22222222-2222-4222-8222-222222222222";
const token = 'test-bridge-secret-with-"-escape-0123456789';
const env = { MOSAIC_N8N_BRIDGE_TOKEN: token };
const logger = { info() {}, error() {} };
function config(
  baseUrl = "https://bridge.example.invalid/webhook/mosaic",
  extra = {},
) {
  return normalizeConfig(
    {
      alertmanagerUrl: "http://127.0.0.1:9093",
      matchLabels: {},
      delivery: { backend: "n8n", n8n: { baseUrl, senderId, recipientId } },
      ...extra,
    },
    env,
  );
}
function root(t) {
  const dir = mkdtempSync(join(tmpdir(), "mosaic-n8n-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function runtime(overrides = {}) {
  const turns = [];
  return {
    turns,
    async run(params) {
      turns.push(params);
      return { runId: "reply-run-" + turns.length };
    },
    async wait() {
      return { status: "ok" };
    },
    async history() {
      return {
        messages: [
          { role: "user", content: turns.at(-1).message },
          {
            role: "assistant",
            content: "Complete automatic reply. 日志 <code> & evidence.",
            stopReason: "stop",
          },
        ],
      };
    },
    async deliver() {
      throw new Error("Native transport must not be called");
    },
    ...overrides,
  };
}
async function setup(t, options = {}) {
  const received = [],
    sent = [];
  const s = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    received.push({ path: req.url, auth: req.headers.authorization, body });
    if (options.handle && (await options.handle(req, res, body))) return;
    const base = {
      protocol: "mosaic-teams-v1",
      senderId,
      recipientId,
      chatId: "19:pair@unq.gbl.spaces",
    };
    let result;
    if (req.url.endsWith("/send")) {
      sent.push(body.text);
      result = {
        ...base,
        messageId: "out-" + sent.length,
        createdDateTime: new Date().toISOString(),
        echo: token,
      };
    } else
      result = {
        ...base,
        messages: options.messages?.(body) ?? [],
        nextToken: options.nextToken?.(body) ?? null,
      };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result));
  });
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => s.close(resolve)));
  const cfg = config(
    `http://127.0.0.1:${s.address().port}/webhook/mosaic`,
    options.config,
  );
  const dir = join(root(t), cfg.stateDirectory),
    rt = options.runtime ?? runtime();
  const bridge = new N8nBridge(cfg, dir, rt, logger, env);
  t.after(() => bridge.stop());
  return { bridge, cfg, dir, rt, received, sent };
}
function message(id, text, at = new Date().toISOString(), user = recipientId) {
  return {
    id,
    createdDateTime: at,
    from: { user: { id: user } },
    messageType: "message",
    body: { contentType: "html", content: "<p>" + text + "</p>" },
  };
}
function allText(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .map((e) => {
      const file = join(dir, e.name);
      return e.isDirectory()
        ? allText(file)
        : /\.(json|txt)$/.test(file)
          ? readFileSync(file, "utf8")
          : "";
    })
    .join("\n");
}

test("n8n is an explicit switch with separate persistent state and readonly peer session", () => {
  const nativeRoute = {
    channel: "feishu",
    target: "user:fixture",
    sessionKey: "agent:default:feishu:direct:fixture",
  };
  const original = normalizeConfig({
    alertmanagerUrl: "http://localhost:9093",
    delivery: nativeRoute,
  });
  const cfg = config(undefined, {
    delivery: {
      ...nativeRoute,
      backend: "n8n",
      n8n: {
        baseUrl: "https://n8n.example.invalid/webhook/mosaic",
        senderId,
        recipientId,
      },
    },
  });
  assert.deepEqual(original.delivery, nativeRoute);
  assert.equal(cfg.nativeStateDirectory, original.stateDirectory);
  assert.notEqual(cfg.stateDirectory, original.stateDirectory);
  assert.equal(isReadonlyAutomationSession(cfg.delivery.sessionKey), true);
  assert.equal(
    contextAllowsEdit({
      sessionKey: cfg.delivery.sessionKey,
      getSessionExtension: () => ({ mode: "auto" }),
    }),
    false,
  );
  assert.deepEqual(
    normalizeConfig({
      alertmanagerUrl: "http://localhost:9093",
      delivery: { ...nativeRoute, backend: "native" },
    }).delivery,
    { ...nativeRoute, backend: "native" },
  );
  for (const profile of [
    { senderId: recipientId },
    { baseUrl: "http://unsafe.example.invalid" },
    { baseUrl: "https://u:p@example.invalid" },
    { baseUrl: "https://example.invalid/?token=bad" },
    { pollSeconds: 0 },
    { maxPages: 0 },
  ])
    assert.throws(() =>
      config(undefined, {
        delivery: {
          backend: "n8n",
          n8n: {
            baseUrl: "https://x.invalid",
            senderId,
            recipientId,
            ...profile,
          },
        },
      }),
    );
  assert.throws(
    () =>
      normalizeConfig(
        {
          alertmanagerUrl: "http://localhost:9093",
          delivery: {
            backend: "n8n",
            n8n: { baseUrl: "https://x.invalid", senderId, recipientId },
          },
        },
        {},
      ),
    /token/,
  );
});

test("renders the selected backend and Secret without altering native route values", () => {
  const args = [
    "template",
    "mosaic",
    fileURLToPath(new URL("..", import.meta.url)),
    "--set",
    "modules.alertAutomation.enabled=true",
    "--set",
    "modules.alertAutomation.delivery.backend=n8n",
    "--set",
    "modules.alertAutomation.delivery.n8n.baseUrl=https://bridge.example.invalid/webhook/test",
    "--set",
    `modules.alertAutomation.delivery.n8n.senderId=${senderId}`,
    "--set",
    `modules.alertAutomation.delivery.n8n.recipientId=${recipientId}`,
    "--set",
    "modules.alertAutomation.delivery.n8n.existingSecret=n8n-test-token",
  ];
  const rendered = execFileSync("helm", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.match(rendered, /"backend": "n8n"/);
  assert.match(
    rendered,
    /name: MOSAIC_N8N_BRIDGE_TOKEN[\s\S]*name: "n8n-test-token"/,
  );
  assert.match(rendered, /alert-automation\.n8n\.ts: \|-/);
  assert.match(rendered, /cp \/seed\/alert-automation\.n8n-config\.ts/);
  assert.doesNotMatch(rendered, /test-bridge-secret/);
  assert.throws(
    () =>
      execFileSync(
        "helm",
        args.filter((_, i) => i !== args.length - 2 && i !== args.length - 1),
        { encoding: "utf8", stdio: "pipe" },
      ),
    /existingSecret/,
  );
});

test("HTML conversion retains displayed commands without executing or decoding markup twice", () => {
  assert.equal(
    teamsMessageText({
      contentType: "html",
      content:
        "<p>read &lt;code&gt; &amp;lt;still&gt;</p><div>A<br>B &#x1f680;</div>",
    }),
    "read <code> &lt;still>\nA\nB 🚀\n",
  );
  assert.equal(
    teamsMessageText({ contentType: "text", content: "<literal> &amp;" }),
    "<literal> &amp;",
  );
  assert.throws(
    () => teamsMessageText({ contentType: "unknown", content: "x" }),
    /Unsupported/,
  );
});

test("losslessly sends a complete long report, retains all receipts, and redacts echoed bearer tokens", async (t) => {
  const { bridge, cfg, dir, received, sent } = await setup(t);
  const report = "完整报告 🚀 <code> & evidence\n".repeat(240);
  const receipt = await bridge.deliver(
    {
      delivery: cfg.delivery,
      report,
      incidentId: "incident-a",
      idempotencyKey: "mosaic-report-a",
      signal: new AbortController().signal,
    },
    (name, value) => save(join(dir, name), value),
  );
  assert.equal(sent.join(""), report);
  assert.ok(receipt.messageIds.length > 2);
  assert.equal(receipt.completeReportSha256, sha256(report));
  assert.ok(received.every((r) => r.auth === "Bearer " + token));
  assert.ok(!JSON.stringify(receipt).includes(token));
  const evidence = allText(dir);
  assert.ok(
    !evidence.includes(token) &&
      !evidence.includes(JSON.stringify(token).slice(1, -1)),
  );
  assert.match(evidence, /REDACTED/);
  assert.equal(
    bridge.db.prepare("SELECT count(*) n FROM outgoing").get().n,
    sent.length,
  );
});

test("new recipient DM automatically runs once, replies completely, and survives deduplicated restart", async (t) => {
  let data = [];
  const { bridge, cfg, dir, rt, sent } = await setup(t, {
    messages: () => data,
  });
  bridge.setMeta("activatedAt", "2026-01-01T00:00:00Z");
  const at = new Date().toISOString();
  data = [
    message("own", "do not loop", at, senderId),
    message("foreign", "no", at, "33333333-3333-4333-8333-333333333333"),
    message("human-1", "请总结报告", at),
  ];
  await bridge.tick();
  await bridge.tick();
  assert.equal(rt.turns.length, 1);
  assert.equal(rt.turns[0].sessionKey, cfg.delivery.sessionKey);
  assert.equal(rt.turns[0].deliver, false);
  assert.match(rt.turns[0].message, /请总结报告/);
  assert.deepEqual(sent, ["Complete automatic reply. 日志 <code> & evidence."]);
  assert.equal(bridge.status().messages[0].state, "sent");
  await bridge.stop();
  const restarted = new N8nBridge(cfg, dir, rt, logger, env);
  t.after(() => restarted.stop());
  await restarted.tick();
  assert.equal(rt.turns.length, 1);
  assert.equal(sent.length, 1);
});

test("resumes capped Graph pagination without dropping old pages or answering in reverse order", async (t) => {
  const { bridge, rt } = await setup(t);
  bridge.config.delivery.n8n.maxPages = 1;
  // This test installs its pages through the bridge's request boundary, independent of network timing.
  bridge.setMeta("activatedAt", "2026-01-01T00:00:00Z");
  const pages = [
    {
      messages: [message("new", "second", "2026-11-04T10:00:02Z")],
      nextToken: "page2",
    },
    {
      messages: [message("old", "first", "2026-11-04T10:00:01Z")],
      nextToken: null,
    },
  ];
  const tokens = [];
  bridge.request = async (action, body) => {
    tokens.push(body.pageToken);
    return pages[body.pageToken ? 1 : 0];
  };
  bridge.deliver = async () => ({ messageIds: ["confirmed"] });
  await bridge.tick();
  assert.equal(rt.turns.length, 0);
  assert.equal(bridge.status().paginationPending, true);
  await bridge.tick();
  assert.equal(rt.turns.length, 2);
  assert.deepEqual(tokens, ["", "page2"]);
  assert.match(rt.turns[0].message, /first/);
  assert.match(rt.turns[1].message, /second/);
});

test("a timed-out outgoing DM remains uncertain and is never automatically duplicated", async (t) => {
  let failed = false;
  const { bridge, cfg, dir, rt, received } = await setup(t, {
    messages: () => [
      message("human-timeout", "question", "2026-11-04T10:00:01Z"),
    ],
    handle: async (req, res) => {
      if (!req.url.endsWith("/send")) return false;
      failed = true;
      res.destroy();
      return true;
    },
  });
  bridge.setMeta("activatedAt", "2026-01-01T00:00:00Z");
  await bridge.tick();
  await bridge.tick();
  assert.equal(failed, true);
  assert.equal(bridge.status().messages[0].state, "delivery_unknown");
  assert.equal(rt.turns.length, 1);
  assert.equal(received.filter((r) => r.path.endsWith("/send")).length, 1);
  await bridge.stop();
  const restarted = new N8nBridge(cfg, dir, rt, logger, env);
  t.after(() => restarted.stop());
  await restarted.tick();
  assert.equal(received.filter((r) => r.path.endsWith("/send")).length, 1);
});

test("interrupted completed Agent run recovers full answer without starting a second run", async (t) => {
  const rt = runtime({
    async run() {
      throw new Error("Must not relaunch");
    },
    async history() {
      return {
        messages: [
          { role: "user", content: "persisted prompt" },
          {
            role: "assistant",
            content: "Recovered full answer",
            stopReason: "stop",
          },
        ],
      };
    },
  });
  const { bridge, sent } = await setup(t, { runtime: rt });
  bridge.db
    .prepare("INSERT INTO incoming VALUES (?,?,?,?,?,?,?,?,?)")
    .run(
      "recovered",
      "m1",
      "2026-11-04T00:00:00Z",
      "running",
      "{}",
      "persisted prompt",
      "old-run",
      null,
      new Date().toISOString(),
    );
  await bridge.processQueued();
  assert.deepEqual(sent, ["Recovered full answer"]);
  assert.equal(bridge.status().messages[0].state, "sent");
});

test("service work does not inherit HTTP request scopes and stops without sending queued messages", async (t) => {
  const scopes = new AsyncLocalStorage();
  const { bridge } = await setup(t);
  let seen;
  bridge.poll = async () => {
    seen = scopes.getStore();
    return true;
  };
  await scopes.run("limited-http-request", () => bridge.tick());
  assert.equal(seen, undefined);
  await bridge.stop();
  await assert.rejects(
    () =>
      bridge.deliver(
        {
          delivery: bridge.config.delivery,
          report: "x",
          incidentId: "x",
          idempotencyKey: "x",
          signal: new AbortController().signal,
        },
        () => {},
      ),
    /abort/i,
  );
});

test("n8n selection retains full native report context and isolates the new reply session", (t) => {
  const dir = root(t),
    cfg = config(),
    nativeDir = join(dir, cfg.nativeStateDirectory),
    store = new Store(nativeDir);
  const sessionKey = "agent:default:feishu:direct:native-person";
  const report = "Native full report retained while the transport is switched.";
  store.bindReport("native-incident", sessionKey, "native-run", report);
  save(
    join(nativeDir, "incidents", "native-incident", "published-report.txt"),
    report,
  );
  const hooks = {};
  const old = process.env.MOSAIC_N8N_BRIDGE_TOKEN;
  process.env.MOSAIC_N8N_BRIDGE_TOKEN = token;
  t.after(() => {
    if (old === undefined) delete process.env.MOSAIC_N8N_BRIDGE_TOKEN;
    else process.env.MOSAIC_N8N_BRIDGE_TOKEN = old;
    store.close();
  });
  registerAlertAutomation({
    pluginConfig: {
      alertmanagerUrl: "http://localhost:9093",
      delivery: { backend: "n8n", n8n: cfg.delivery.n8n },
    },
    runtime: { state: { resolveStateDir: () => dir } },
    registerService() {},
    registerGatewayMethod() {},
    on(name, fn) {
      hooks[name] = fn;
    },
  });
  assert.match(
    hooks.before_prompt_build({ prompt: "summarize" }, { sessionKey })
      .prependContext,
    /Native full report retained/,
  );
  assert.equal(
    hooks.before_prompt_build(
      { prompt: "summarize" },
      { sessionKey: cfg.delivery.sessionKey },
    ),
    undefined,
  );
  assert.ok(existsSync(join(nativeDir, "state.sqlite3")));
});

test("alert investigation publishes its complete report and pins the following DM to that incident", async (t) => {
  let incoming = [];
  const { bridge, cfg, dir, rt, sent } = await setup(t, {
    messages: () => incoming,
  });
  const service = new AlertService(
    cfg,
    dir,
    { ...rt, deliver: bridge.deliver },
    logger,
    env,
  );
  t.after(() => service.stop());
  const alert = {
    fingerprint: "1234567890abcdef",
    startsAt: new Date().toISOString(),
    status: { state: "active", silencedBy: [], inhibitedBy: [] },
    labels: {
      run_id: "n8n-closed-loop-fixture",
      alertname: "GpuTelemetrySimulation",
    },
    annotations: {},
  };
  service.store.ingest([alert], cfg);
  const incident = incidentKey(alert);
  await service.process(incident);
  assert.equal(service.store.get(incident).state, "sent");
  const report = service.store.reportContext(cfg.delivery.sessionKey).report;
  assert.equal(sent.join(""), report);
  assert.match(report, /n8n-closed-loop-fixture/);
  incoming = [
    message(
      "followup",
      "请总结刚才的报告",
      new Date(Date.now() + 1000).toISOString(),
    ),
  ];
  await bridge.tick();
  assert.equal(rt.turns.length, 2);
  assert.match(
    rt.turns[1].message,
    new RegExp("Associated alert incident: " + incident),
  );
  assert.equal(bridge.status().messages[0].state, "sent");
  const hooks = {},
    old = process.env.MOSAIC_N8N_BRIDGE_TOKEN;
  process.env.MOSAIC_N8N_BRIDGE_TOKEN = token;
  try {
    registerAlertAutomation({
      pluginConfig: {
        alertmanagerUrl: "http://localhost:9093",
        delivery: { backend: "n8n", n8n: cfg.delivery.n8n },
      },
      runtime: { state: { resolveStateDir: () => join(dir, "..") } },
      registerService() {},
      registerGatewayMethod() {},
      on(name, fn) {
        hooks[name] = fn;
      },
    });
    const restored = hooks.before_prompt_build(
      { prompt: rt.turns[1].message },
      { sessionKey: cfg.delivery.sessionKey },
    );
    assert.ok(restored.prependContext.includes(report));
    assert.ok(restored.prependContext.includes(incident));
  } finally {
    if (old === undefined) delete process.env.MOSAIC_N8N_BRIDGE_TOKEN;
    else process.env.MOSAIC_N8N_BRIDGE_TOKEN = old;
  }
});

test("rejects receipts for another identity or conversation without calling native fallback", async (t) => {
  let different = false;
  const { bridge, cfg } = await setup(t, {
    handle: async (req, res) => {
      res.end(
        JSON.stringify({
          protocol: "mosaic-teams-v1",
          senderId: different ? senderId : recipientId,
          recipientId,
          chatId: "changed-chat",
          messageId: "x",
          createdDateTime: new Date().toISOString(),
        }),
      );
      return true;
    },
  });
  const params = {
    delivery: cfg.delivery,
    report: "x",
    incidentId: "x",
    idempotencyKey: "x",
    signal: new AbortController().signal,
  };
  await assert.rejects(() => bridge.deliver(params, () => {}), /identities/);
  assert.equal(bridge.meta("chatId"), undefined);
  bridge.setMeta("chatId", "original-chat");
  different = true;
  await assert.rejects(
    () => bridge.deliver(params, () => {}),
    /changed.*conversation/,
  );
  assert.equal(bridge.meta("chatId"), "original-chat");
});

test("starts from activation time and does not replay an earlier private conversation", async (t) => {
  const { bridge, rt } = await setup(t, {
    messages: () => [
      message("old-private-message", "old context", "2020-01-01T00:00:00Z"),
    ],
  });
  await bridge.tick();
  assert.equal(rt.turns.length, 0);
  assert.deepEqual(bridge.status().messages, []);
});
