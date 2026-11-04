// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  completedReport,
  readStoredReportContext,
  save,
  sha256,
  type Config,
  type Runtime,
} from "./core.ts";
import { reportChunks } from "./runtime.ts";

type Json = Record<string, any>;
const stamp = () => new Date().toISOString();

/** Convert displayed Graph text without evaluating HTML or dropping quoted code. */
export function teamsMessageText(body: Json) {
  if (typeof body?.content !== "string")
    throw new Error("Graph message has no text body");
  if (body.contentType === "text") return body.content;
  if (body.contentType !== "html")
    throw new Error("Unsupported Graph message content type");
  const entities: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return body.content
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|li|pre)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(
      /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
      (whole: string, key: string) => {
        if (key[0] !== "#") return entities[key.toLowerCase()] ?? whole;
        const point = parseInt(
          key.slice(key[1].toLowerCase() === "x" ? 2 : 1),
          key[1].toLowerCase() === "x" ? 16 : 10,
        );
        return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
          ? String.fromCodePoint(point)
          : whole;
      },
    );
}

/** Optional outbound-only connection: Spark calls n8n; no new inbound Spark port. */
export class N8nBridge {
  config: Config;
  root: string;
  runtime: Runtime;
  env: NodeJS.ProcessEnv;
  db: DatabaseSync;
  controller = new AbortController();
  context = new AsyncResource("mosaic-n8n-bridge-service");
  timer: ReturnType<typeof setInterval> | undefined;
  processing: Promise<void> | undefined;
  sendQueue: Promise<unknown> = Promise.resolve();
  logger: { info: (value: string) => void; error: (value: string) => void };
  closed = false;

  constructor(
    config: Config,
    root: string,
    runtime: Runtime,
    logger: N8nBridge["logger"],
    env: NodeJS.ProcessEnv = process.env,
  ) {
    if (config.delivery.backend !== "n8n" || !config.delivery.n8n)
      throw new Error("n8n bridge must be explicitly selected");
    this.config = config;
    this.root = root;
    this.runtime = runtime;
    this.env = env;
    this.logger = logger;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(root, "n8n-messages.sqlite3"));
    chmodSync(path.join(root, "n8n-messages.sqlite3"), 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS incoming (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL, created_at TEXT NOT NULL,
        state TEXT NOT NULL, message_json TEXT NOT NULL, prompt TEXT NOT NULL,
        run_id TEXT, report_incident_id TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outgoing (
        message_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, incident_id TEXT NOT NULL,
        kind TEXT NOT NULL, created_at TEXT NOT NULL, receipt_json TEXT NOT NULL);`);
    if (!this.meta("activatedAt")) this.setMeta("activatedAt", stamp());
    this.db
      .prepare(
        "UPDATE incoming SET state='delivery_unknown',updated_at=? WHERE state='sending'",
      )
      .run(stamp());
  }
  meta(key: string): any {
    const row = this.db
      .prepare("SELECT value FROM metadata WHERE key=?")
      .get(key) as Json | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  setMeta(key: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, JSON.stringify(value));
  }
  scrub(value: unknown) {
    if (value === undefined) return null;
    if (Array.isArray(value)) return value.map((item) => this.scrub(item));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.scrub(item)]),
      );
    if (typeof value !== "string") return value;
    let text = value;
    const token = this.env[this.config.delivery.n8n!.tokenEnv];
    if (token)
      for (const secret of [
        token,
        JSON.stringify(token).slice(1, -1),
        encodeURIComponent(token),
      ])
        text = text.split(secret).join("[REDACTED]");
    return text;
  }
  record(directory: string) {
    return (name: string, value: unknown) =>
      save(path.join(directory, name), this.scrub(value));
  }
  active(signal?: AbortSignal) {
    this.controller.signal.throwIfAborted();
    signal?.throwIfAborted();
  }
  async request(
    action: "send" | "read",
    body: Json,
    record: (name: string, value: unknown) => void,
    signal?: AbortSignal,
  ) {
    this.active(signal);
    const cfg = this.config.delivery.n8n!;
    const token = this.env[cfg.tokenEnv];
    if (!token || token.length < 24)
      throw new Error("n8n bridge token is unavailable");
    const url = cfg.baseUrl + "/" + action;
    const payload = {
      ...body,
      protocol: "mosaic-teams-v1",
      recipientId: cfg.recipientId,
    };
    record("request.json", this.scrub({ url, method: "POST", body: payload }));
    const signals = [this.controller.signal, AbortSignal.timeout(30000)];
    if (signal) signals.push(signal);
    const response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.any(signals),
    });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (response.body)
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 20 * 1024 * 1024)
          throw new Error("n8n response exceeds complete evidence limit");
        chunks.push(chunk);
      }
    const text = Buffer.concat(chunks).toString("utf8");
    record(
      "response.json",
      this.scrub({ status: response.status, body: text }),
    );
    if (!response.ok) throw new Error(`n8n HTTP ${response.status}`);
    const data = JSON.parse(text);
    if (
      data.protocol !== "mosaic-teams-v1" ||
      data.senderId?.toLowerCase() !== cfg.senderId ||
      data.recipientId?.toLowerCase() !== cfg.recipientId ||
      typeof data.chatId !== "string" ||
      !data.chatId ||
      data.chatId.length > 1024
    )
      throw new Error("n8n receipt does not match the fixed Teams identities");
    const old = this.meta("chatId");
    if (old && old !== data.chatId)
      throw new Error("n8n changed the fixed conversation");
    this.active(signal);
    this.setMeta("chatId", data.chatId);
    return this.scrub(data);
  }
  deliver: Runtime["deliver"] = (params, record) => {
    const safeRecord = (name: string, value: unknown) =>
      record(name, this.scrub(value));
    const task = this.sendQueue.then(() => this.send(params, safeRecord));
    this.sendQueue = task.catch(() => {});
    return task;
  };
  private async send(
    params: Parameters<Runtime["deliver"]>[0],
    record: (name: string, value: unknown) => void,
  ) {
    const { delivery, report, signal } = params;
    if (
      delivery.backend !== "n8n" ||
      delivery.target !== this.config.delivery.target ||
      delivery.sessionKey !== this.config.delivery.sessionKey
    )
      throw new Error("n8n cannot publish a native or different-peer delivery");
    const parts = reportChunks(report),
      receipts: Json[] = [];
    record("n8n-delivery.intent.json", {
      backend: "n8n",
      sessionKey: delivery.sessionKey,
      idempotencyKey: params.idempotencyKey,
      messageBytes: Buffer.byteLength(report),
      messageSha256: sha256(report),
      contentTruncated: false,
      parts: parts.length,
    });
    for (let index = 0; index < parts.length; index++) {
      this.active(signal);
      const partRecord = (name: string, value: unknown) =>
        record(`n8n-delivery.part-${index + 1}.${name}`, value);
      const receipt = await this.request(
        "send",
        {
          action: "send",
          text: parts[index],
          chatId: this.meta("chatId") ?? "",
          deliveryId: params.idempotencyKey + ":" + index,
        },
        partRecord,
        signal,
      );
      if (
        typeof receipt.messageId !== "string" ||
        !receipt.messageId ||
        !Number.isFinite(Date.parse(receipt.createdDateTime))
      )
        throw new Error("n8n returned no confirmed Graph message receipt");
      this.db
        .prepare("INSERT OR IGNORE INTO outgoing VALUES (?,?,?,?,?,?)")
        .run(
          receipt.messageId,
          receipt.chatId,
          params.incidentId,
          params.idempotencyKey.startsWith("mosaic-n8n-reply-")
            ? "reply"
            : "report",
          receipt.createdDateTime,
          JSON.stringify(this.scrub(receipt)),
        );
      receipts.push(receipt);
      record("n8n-delivery.progress.json", {
        completedParts: receipts.length,
        totalParts: parts.length,
        messageIds: receipts.map((r) => r.messageId),
      });
    }
    return {
      channel: "n8n",
      messageIds: receipts.map((r) => r.messageId),
      results: receipts,
      sessionKey: delivery.sessionKey,
      completeReportSha256: sha256(report),
    };
  }
  start() {
    if (this.timer) return;
    const tick = () =>
      void this.tick().catch((error) =>
        this.logger.error(`n8n bridge: ${error.name}`),
      );
    this.timer = setInterval(
      tick,
      this.config.delivery.n8n!.pollSeconds * 1000,
    );
    this.timer.unref();
    tick();
  }
  tick() {
    if (this.processing || this.controller.signal.aborted)
      return this.processing ?? Promise.resolve();
    this.processing = this.context
      .runInAsyncScope(async () => {
        try {
          if (await this.poll()) await this.processQueued();
        } catch (error) {
          if (!this.controller.signal.aborted) {
            this.setMeta("lastError", {
              at: stamp(),
              message: this.scrub(String(error)),
            });
            const cursor = this.meta("cursor");
            if (cursor) {
              cursor.failures = (cursor.failures ?? 0) + 1;
              this.setMeta("cursor", cursor.failures >= 3 ? null : cursor);
            }
            // Already persisted turns must not be stranded by a temporary Graph
            // read failure or a full pending queue. Never advance the read cursor.
            await this.processQueued();
          }
          throw error;
        }
      })
      .finally(() => {
        this.processing = undefined;
      });
    return this.processing;
  }
  async poll() {
    this.active();
    const cfg = this.config.delivery.n8n!;
    let cursor = this.meta("cursor") ?? {
      token: "",
      boundary: this.meta("watermark") ?? this.meta("activatedAt"),
      newest: "",
    };
    const trace = path.join(
      this.root,
      "n8n-polls",
      Date.now() + "-" + randomUUID(),
    );
    for (let page = 0; page < cfg.maxPages; page++) {
      const record = this.record(path.join(trace, String(page + 1)));
      const data = await this.request(
        "read",
        {
          action: "read",
          chatId: this.meta("chatId") ?? "",
          pageToken: cursor.token,
        },
        record,
      );
      if (
        !Array.isArray(data.messages) ||
        data.messages.length > 50 ||
        (data.nextToken !== null && typeof data.nextToken !== "string")
      )
        throw new Error("Malformed n8n Graph page");
      const selected: Json[] = [];
      let boundary = false,
        previous = Infinity;
      for (const message of data.messages) {
        const created = Date.parse(message.createdDateTime);
        if (
          !Number.isFinite(created) ||
          created > Date.now() + 300000 ||
          created > previous
        )
          throw new Error("n8n page is not in descending creation order");
        previous = created;
        if (!cursor.newest || created > Date.parse(cursor.newest))
          cursor.newest = message.createdDateTime;
        if (created < Date.parse(cursor.boundary)) {
          boundary = true;
          continue;
        }
        if (
          message.from?.user?.id?.toLowerCase() !== cfg.recipientId ||
          message.deletedDateTime ||
          (message.messageType && message.messageType !== "message")
        )
          continue;
        if (
          typeof message.id !== "string" ||
          !message.id ||
          (message.chatId && message.chatId !== data.chatId)
        )
          throw new Error("Graph message has invalid conversation metadata");
        const id = sha256(data.chatId + "\n" + message.id);
        const text = this.scrub(teamsMessageText(message.body)) as string;
        if (!text.trim()) {
          record(`empty-${id}.json`, message);
          continue;
        }
        const existing = this.db
          .prepare("SELECT id FROM incoming WHERE id=?")
          .get(id);
        if (!existing) selected.push({ id, message, text });
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const pending = this.db
          .prepare(
            "SELECT count(*) AS n FROM incoming WHERE state IN ('queued','running','ready')",
          )
          .get() as Json;
        if (Number(pending.n) + selected.length > this.config.maxPending)
          throw new Error(
            "n8n pending message capacity exceeded; page not acknowledged",
          );
        for (const { id, message, text } of selected) {
          const latest = readStoredReportContext(
            this.root,
            this.config.delivery.sessionKey,
            text,
          );
          let incident =
            latest &&
            (text.includes(latest.incident_id) || text.includes(latest.run_id))
              ? latest.incident_id
              : undefined;
          if (!incident)
            incident = (
              this.db
                .prepare(
                  "SELECT incident_id FROM outgoing WHERE kind='report' AND created_at<=? ORDER BY created_at DESC LIMIT 1",
                )
                .get(message.createdDateTime) as Json | undefined
            )?.incident_id;
          const prompt =
            "An authenticated Teams direct message is forwarded by the configured n8n bridge. " +
            "Answer as the MOSAIC Agent using this conversation and any associated complete alert report. " +
            "Stay within View permissions. Do not send another notification; the bridge publishes your complete answer.\n" +
            `Message ID: ${message.id}\n` +
            (incident ? `Associated alert incident: ${incident}\n` : "") +
            "User message:\n" +
            text;
          this.db
            .prepare(
              "INSERT OR IGNORE INTO incoming VALUES (?,?,?,?,?,?,?,?,?)",
            )
            .run(
              id,
              message.id,
              message.createdDateTime,
              "queued",
              JSON.stringify(this.scrub(message)),
              prompt,
              null,
              incident ?? null,
              stamp(),
            );
          this.record(path.join(this.root, "n8n-replies", id))("input.json", {
            message,
            prompt,
            sessionKey: this.config.delivery.sessionKey,
            reportIncidentId: incident ?? null,
          });
        }
        cursor.token = data.nextToken ?? "";
        cursor.failures = 0;
        if (boundary || !cursor.token) {
          this.setMeta("cursor", null);
          if (cursor.newest) this.setMeta("watermark", cursor.newest);
        } else this.setMeta("cursor", cursor);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      this.setMeta("lastPollAt", stamp());
      this.setMeta("lastError", null);
      if (boundary || !cursor.token) return true;
    }
    return false;
  }
  async processQueued() {
    const rows = this.db
      .prepare(
        "SELECT * FROM incoming WHERE state IN ('queued','running','ready') ORDER BY created_at,id LIMIT 20",
      )
      .all() as Json[];
    for (const row of rows) {
      this.active();
      await this.process(row);
    }
  }
  async process(row: Json) {
    const directory = path.join(this.root, "n8n-replies", row.id),
      record = this.record(directory);
    const change = (state: string) =>
      this.db
        .prepare("UPDATE incoming SET state=?,updated_at=? WHERE id=?")
        .run(state, stamp(), row.id);
    try {
      if (row.state !== "ready") {
        let answer: string | undefined;
        if (row.state === "running") {
          try {
            const history = await this.runtime.history({
              sessionKey: this.config.delivery.sessionKey,
              limit: 1000,
            });
            record("recovery.history.json", history);
            answer = completedReport(history.messages, row.prompt);
          } catch {
            /* A persisted run may still be running. Never start a second Agent turn. */
          }
          if (!answer && !row.run_id)
            throw new Error(
              "Interrupted n8n Agent dispatch needs reconciliation",
            );
        } else {
          change("running");
          const params = {
            sessionKey: this.config.delivery.sessionKey,
            message: row.prompt,
            deliver: false,
            idempotencyKey: "mosaic-n8n-message-" + row.id,
          };
          record("agent.request.json", params);
          const run = await this.runtime.run(params);
          row.run_id = run.runId;
          this.active();
          this.db
            .prepare("UPDATE incoming SET run_id=? WHERE id=?")
            .run(run.runId, row.id);
          record("agent.run.json", run);
        }
        if (!answer) {
          const result = await this.runtime.wait({
            runId: row.run_id,
            timeoutMs: this.config.timeoutSeconds * 1000,
          });
          record("agent.completion.json", result);
          this.active();
          if (result.status !== "ok")
            throw new Error("n8n reply Agent did not finish: " + result.status);
          const history = await this.runtime.history({
            sessionKey: this.config.delivery.sessionKey,
            limit: 1000,
          });
          record("agent.history.json", history);
          answer = completedReport(history.messages, row.prompt);
        }
        record("model-reply.txt", answer);
        const published = this.scrub(answer) as string;
        record("reply-integrity.json", {
          sha256: sha256(published),
          bytes: Buffer.byteLength(published),
          contentTruncated: false,
          modelFactCorrectionsApplied: false,
        });
        change("ready");
      }
      this.active();
      const answer = readFileSync(
        path.join(directory, "model-reply.txt"),
        "utf8",
      );
      const integrity = JSON.parse(
        readFileSync(path.join(directory, "reply-integrity.json"), "utf8"),
      );
      if (sha256(answer) !== integrity.sha256)
        throw new Error("Stored n8n reply integrity mismatch");
      change("sending");
      const receipt = await this.deliver(
        {
          delivery: this.config.delivery,
          report: answer,
          incidentId: "n8n-reply-" + row.id,
          idempotencyKey: "mosaic-n8n-reply-" + row.id,
          signal: this.controller.signal,
        },
        record,
      );
      record("delivery.receipt.json", receipt);
      this.active();
      change("sent");
    } catch (error) {
      if (this.controller.signal.aborted) return;
      record("failure.json", { at: stamp(), error: this.scrub(String(error)) });
      const current = this.db
        .prepare("SELECT state FROM incoming WHERE id=?")
        .get(row.id) as Json;
      change(
        current.state === "sending" ? "delivery_unknown" : "needs_attention",
      );
    }
  }
  status() {
    return {
      running: !!this.timer && !this.controller.signal.aborted,
      backend: "n8n",
      senderId: this.config.delivery.n8n!.senderId,
      recipientId: this.config.delivery.target,
      sessionKey: this.config.delivery.sessionKey,
      chatId: this.meta("chatId"),
      pollSeconds: this.config.delivery.n8n!.pollSeconds,
      lastPollAt: this.meta("lastPollAt"),
      paginationPending: !!this.meta("cursor"),
      lastError: this.meta("lastError"),
      messages: this.db
        .prepare(
          "SELECT id,message_id,state,run_id,created_at,updated_at FROM incoming ORDER BY created_at",
        )
        .all(),
    };
  }
  async stop() {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.context.emitDestroy();
    await Promise.allSettled([this.processing, this.sendQueue]);
    this.db.close();
  }
}
