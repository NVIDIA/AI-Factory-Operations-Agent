// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Isolated model/tool replay, deliberately separate from native OpenClaw tests.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { cases, replayCases, end, start, interval, metric, userPrompt } from "./fixtures/metric-history-cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const extension = "helm/mosaic-stack/files/openclaw-seed/extensions/observability";
const skillPath = "helm/mosaic-stack/files/openclaw-seed/skills/observability/SKILL.md";
const NativeDate = Date;
const nativeFetch = globalThis.fetch;
const sha = value => createHash("sha256").update(value).digest("hex");
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
const log = (path, value) => appendFileSync(path, JSON.stringify(value) + "\n");
const iso = seconds => new NativeDate(seconds * 1000).toISOString();
const textResult = result => result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") ?? JSON.stringify(result);
const integer = (value, fallback, max, name) => {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw new Error(`${name} must be an integer from 1 to ${max}`);
  return result;
};

export function endpoint(value, name, loopback = false) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be HTTP(S) without credentials, query, or fragment`);
  }
  if (loopback && !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error(`${name} must address the local synthetic fixture, not production`);
  }
  return url.toString().replace(/\/+$/, "");
}

export function parseOptions(argv) {
  const options = {};
  const allowed = new Set(["source", "prometheus", "model-url", "model", "output", "case", "repetitions", "max-turns", "max-tokens", "temperature", "timeout-ms", "cache", "model-options", "model-revision", "server-revision"]);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (!argv[i]?.startsWith("--") || !allowed.has(key) || argv[i + 1] === undefined || key in options) {
      throw new Error(`Invalid or repeated option: ${argv[i]}`);
    }
    options[key] = argv[i + 1];
  }
  for (const key of ["source", "prometheus", "model-url", "model", "output"]) {
    if (!options[key]?.trim()) throw new Error(`--${key} is required`);
  }
  const selected = options.case && options.case !== "all" ? options.case.split(",") : replayCases.map(item => item.id);
  if (new Set(selected).size !== selected.length || selected.some(id => !replayCases.some(item => item.id === id))) throw new Error("Unknown or repeated case");
  const cache = options.cache ?? "normal";
  if (!["normal", "isolated"].includes(cache)) throw new Error("--cache must be normal or isolated");
  const temperature = Number(options.temperature ?? 0);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error("--temperature must be from 0 to 2");
  const modelOptions = options["model-options"] ? JSON.parse(readFileSync(options["model-options"], "utf8")) : {};
  if (!modelOptions || Array.isArray(modelOptions) || typeof modelOptions !== "object" ||
      Object.keys(modelOptions).some(key => !["chat_template_kwargs", "reasoning_effort", "top_p"].includes(key))) {
    throw new Error("Model options may contain only chat_template_kwargs, reasoning_effort and top_p");
  }
  if (modelOptions.top_p !== undefined && (typeof modelOptions.top_p !== "number" || !Number.isFinite(modelOptions.top_p) || modelOptions.top_p <= 0 || modelOptions.top_p > 1)) throw new Error("top_p must be from 0 (exclusive) to 1");
  if (modelOptions.chat_template_kwargs !== undefined && (!modelOptions.chat_template_kwargs || Array.isArray(modelOptions.chat_template_kwargs) || typeof modelOptions.chat_template_kwargs !== "object")) throw new Error("chat_template_kwargs must be an object");
  if (modelOptions.reasoning_effort !== undefined && typeof modelOptions.reasoning_effort !== "string") throw new Error("reasoning_effort must be a string");
  return {
    source: resolve(options.source), output: resolve(options.output),
    prometheus: endpoint(options.prometheus, "--prometheus", true),
    modelUrl: endpoint(options["model-url"], "--model-url"), model: options.model,
    modelRevision: options["model-revision"] ?? "unrecorded", serverRevision: options["server-revision"] ?? "unrecorded",
    selected, cache, modelOptions, temperature,
    repetitions: integer(options.repetitions, 3, 100, "--repetitions"),
    maxTurns: integer(options["max-turns"], 24, 100, "--max-turns"),
    maxTokens: integer(options["max-tokens"], 2200, 32768, "--max-tokens"),
    timeoutMs: integer(options["timeout-ms"], 180000, 600000, "--timeout-ms"),
  };
}

export function validateFixture(payload) {
  assert.equal(payload.status, "success", "fixture query failed");
  assert.ok(!payload.warnings?.length && payload.isPartial !== true, "partial fixture response");
  assert.equal(payload.data?.resultType, "matrix", "fixture must return original samples");
  const result = payload.data.result;
  assert.ok(Array.isArray(result));
  assert.equal(result.length, cases.filter(item => item.count).length, "unexpected fixture series");
  const canonical = [];
  for (const scenario of cases) {
    const matches = result.filter(series => series.metric?.Hostname === scenario.host);
    assert.equal(matches.length, scenario.count ? 1 : 0, scenario.id);
    if (!scenario.count) continue;
    const series = matches[0];
    assert.deepEqual(series.metric, { __name__: metric, Hostname: scenario.host, gpu: "0" });
    assert.equal(series.values?.length, scenario.count, scenario.id);
    assert.ok(!series.histograms?.length, "histograms are not the test fixture");
    for (let i = 0; i < scenario.count; i++) {
      assert.deepEqual(series.values[i], [start + i * interval, String(scenario.value)], `${scenario.id} sample ${i}`);
    }
    assert.equal(series.values.at(-1)[0], scenario.last);
    canonical.push({ metric: series.metric, values: series.values });
  }
  return { sampleCount: cases.reduce((sum, item) => sum + item.count, 0), sha256: sha(JSON.stringify(canonical)) };
}

async function verifyFixture(url, output) {
  const query = new URL(`${url}/api/v1/query`);
  query.searchParams.set("query", `${metric}[${end - start + 1}s]`);
  query.searchParams.set("time", String(end));
  const response = await nativeFetch(query, { redirect: "error", signal: AbortSignal.timeout(15000) });
  const body = await response.text();
  json(join(output, "fixture-preflight.json"), { url: query.toString(), status: response.status, body });
  if (!response.ok) throw new Error(`Fixture HTTP ${response.status}`);
  return validateFixture(JSON.parse(body));
}

function sourceSnapshot(source, output) {
  const files = [...readdirSync(join(source, extension)).filter(name => name.endsWith(".ts")).map(name => `${extension}/${name}`), skillPath].sort();
  const hashes = {};
  for (const path of files) {
    const data = readFileSync(join(source, path));
    hashes[path] = sha(data);
    const target = join(output, "source", path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  let commit = null;
  try { commit = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
  return { path: source, commit, hashes };
}

async function loadTools(source) {
  // Only the SDK registration wrapper is stubbed. Real metrics plugin code,
  // schemas, history helper and skill are loaded from the requested revision.
  const hooks = registerHooks({ resolve(specifier, context, next) {
    return specifier === "openclaw/plugin-sdk/plugin-entry"
      ? { url: "data:text/javascript,export const definePluginEntry = value => value;", shortCircuit: true }
      : next(specifier, context);
  } });
  let plugin;
  try { ({ default: plugin } = await import(pathToFileURL(join(source, extension, "index.ts")))); }
  finally { hooks.deregister(); }
  const tools = new Map();
  plugin.register({ pluginConfig: { prometheusUrl: "http://metrics-fixture.invalid", grafanaEnabled: false },
    registerTool: tool => tools.set(tool.name, tool) });
  if (!tools.has("observability_range_query") || [...tools.keys()].some(name => !name.startsWith("observability_"))) throw new Error("Unexpected replay tool set");
  return tools;
}

export function initialMessages(skill, scenario) {
  return [
    { role: "system", content: `You are Mosaic, an operations assistant. Current time: ${iso(end)}. Use the available read-only observability tools to investigate the user's question. This environment scrapes metrics every ${interval} seconds. The observability skill is loaded below. Answer in the user's language.\n\n${skill}` },
    { role: "user", content: userPrompt(scenario) },
  ];
}

export async function runCase(options, scenario, repetition, tools, skill) {
  const output = join(options.output, `${scenario.id}-${repetition}`);
  mkdirSync(output);
  const messages = initialMessages(skill, scenario);
  const schemas = [...tools.values()].map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
  const calls = [], usages = [], backend = [];
  const started = performance.now();
  let final = null, stop = "turn_budget", modelTurns = 0;
  const previousFetch = globalThis.fetch, previousDate = globalThis.Date;
  class FrozenDate extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [end * 1000])); }
    static now() { return end * 1000; }
  }
  globalThis.Date = FrozenDate;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin !== "http://metrics-fixture.invalid" || (init.method ?? "GET") !== "GET" ||
        !["/api/v1/query", "/api/v1/query_range", "/api/v1/label/__name__/values"].includes(url.pathname)) {
      throw new Error("Tool request outside the read-only fixture");
    }
    const forwarded = new URL(options.prometheus + url.pathname + url.search);
    if (url.pathname === "/api/v1/query" && !forwarded.searchParams.has("time")) forwarded.searchParams.set("time", String(end));
    try {
      const response = await nativeFetch(forwarded, { ...init, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(15000), ...(init.signal ? [init.signal] : [])]) });
      const body = await response.text();
      const record = { requestedUrl: url.toString(), forwardedUrl: forwarded.toString(), status: response.status, body };
      backend.push(record);
      log(join(output, "backend.jsonl"), record);
      return new Response(body, { status: response.status, headers: { "content-type": "application/json" } });
    } catch (error) {
      const record = { requestedUrl: url.toString(), forwardedUrl: forwarded.toString(), transportError: error.name };
      backend.push(record);
      log(join(output, "backend.jsonl"), record);
      throw error;
    }
  };
  try {
    if (scenario.followup) {
      const params = { query: `${metric}{Hostname="${scenario.host}",gpu="0"}`, rangeMinutes: 120, end: iso(end), stepSeconds: interval };
      const call = { id: "seeded-recent-window", type: "function", function: { name: "observability_range_query", arguments: JSON.stringify(params) } };
      const result = await tools.get(call.function.name).execute(call.id, params);
      json(join(output, "seeded-tool.json"), { call, params, result });
      const seed = JSON.parse(textResult(result));
      if (result.isError || seed.resultType !== "matrix" || seed.seriesCount !== 0 || !Array.isArray(seed.result) || seed.result.length !== 0) {
        throw new Error("Follow-up seed must be a successful empty recent-window query");
      }
      messages.push({ role: "assistant", content: null, tool_calls: [call] },
        { role: "tool", tool_call_id: call.id, content: textResult(result) },
        { role: "assistant", content: "最近两小时，这个主机的 GPU 0 指标没有返回样本。" },
        { role: "user", content: "这个问题是什么时候开始的？请给出时间依据。" });
    }
    json(join(output, "initial-messages.json"), messages);
    json(join(output, "tool-schemas.json"), schemas);
    for (let turn = 0; turn < options.maxTurns; turn++) {
      const body = { ...options.modelOptions, model: options.model, messages, tools: schemas, tool_choice: "auto",
        temperature: options.temperature, seed: repetition, max_tokens: options.maxTokens, parallel_tool_calls: false };
      if (options.cache === "isolated") body.cache_salt = `metric-history-${randomUUID()}`;
      // Auth headers are never recorded. Provider options must not contain secrets.
      log(join(output, "model-requests.jsonl"), { turn, body });
      const requestStart = performance.now();
      const response = await nativeFetch(`${options.modelUrl}/chat/completions`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(options.timeoutMs),
        headers: { "content-type": "application/json", ...(process.env.MOSAIC_REPLAY_API_KEY ? { authorization: `Bearer ${process.env.MOSAIC_REPLAY_API_KEY}` } : {}) },
        body: JSON.stringify(body),
      });
      const raw = await response.text();
      log(join(output, "model-responses.jsonl"), { turn, status: response.status, elapsedMs: performance.now() - requestStart, body: raw });
      modelTurns++;
      if (!response.ok) throw new Error(`Model HTTP ${response.status}`);
      const payload = JSON.parse(raw), choice = payload.choices?.[0], answer = choice?.message;
      usages.push(payload.usage ?? null);
      if (!answer || (answer.content != null && typeof answer.content !== "string")) throw new Error("Invalid model response");
      if (answer.tool_calls !== undefined && !Array.isArray(answer.tool_calls)) throw new Error("Invalid tool_calls");
      messages.push({ role: "assistant", content: answer.content ?? null, ...(answer.tool_calls?.length ? { tool_calls: answer.tool_calls } : {}) });
      if (!answer.tool_calls?.length) {
        final = answer.content ?? "";
        stop = /<tool_call>|<function=/.test(final) ? "unparsed_tool_call" : !final.trim() ? "empty_answer" : choice.finish_reason ?? "unknown_finish";
        break;
      }
      if (choice.finish_reason === "length") { stop = "length"; break; }
      if (answer.tool_calls.length > 16) throw new Error("Too many tool calls in one turn");
      for (const call of answer.tool_calls) {
        if (typeof call.id !== "string" || !call.function || typeof call.function.name !== "string") throw new Error("Malformed tool call");
        let params = null, result;
        try {
          params = JSON.parse(call.function.arguments);
          const tool = tools.get(call.function.name);
          if (!tool) throw new Error("Tool unavailable in this fixture");
          result = await tool.execute(call.id, params);
        } catch (error) { result = { isError: true, content: [{ type: "text", text: error.message }] }; }
        const record = { turn, name: call.function.name, params, result };
        calls.push(record);
        log(join(output, "tools.jsonl"), record);
        messages.push({ role: "tool", tool_call_id: call.id, content: textResult(result) });
      }
      json(join(output, "transcript.json"), messages);
    }
  } catch (error) {
    stop = "replay_error";
    json(join(output, "error.json"), { name: error.name, message: error.message });
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.Date = previousDate;
  }
  json(join(output, "transcript.json"), messages);
  writeFileSync(join(output, "answer.txt"), final ?? "No completed answer.\n");
  const summary = {
    case: scenario.id, repetition, stop, modelTurns, toolCalls: calls.length,
    toolErrors: calls.filter(call => call.result.isError || call.result.details?.status === "incomplete").length,
    backendRequests: backend.length, elapsedMs: performance.now() - started, usages, final,
    // These are execution observations, not a grade for natural-language claims.
    completed: stop === "stop", investigated: calls.length > 0,
    answerReview: "pending", expected: { ...scenario, lastIso: scenario.last === null ? null : iso(scenario.last), missingIso: scenario.missing === null ? null : iso(scenario.missing) },
  };
  json(join(output, "summary.json"), summary);
  return summary;
}

export async function runSuite(options) {
  mkdirSync(options.output); // Never mix with or overwrite an earlier experiment.
  const fixture = await verifyFixture(options.prometheus, options.output);
  const source = sourceSnapshot(options.source, options.output);
  const tools = await loadTools(options.source);
  const skill = readFileSync(join(options.source, skillPath), "utf8");
  const suiteHash = sha(readFileSync(join(here, "fixtures/metric-history-cases.mjs")));
  const manifest = {
    schemaVersion: 1, startedAt: new NativeDate().toISOString(), mode: "isolated-model-tool-replay",
    source, runnerSha256: sha(readFileSync(fileURLToPath(import.meta.url))), suiteSha256: suiteHash,
    fixture, fixedTime: iso(end), node: process.version,
    model: options.model, modelUrl: options.modelUrl, modelRevision: options.modelRevision, serverRevision: options.serverRevision,
    settings: { temperature: options.temperature, seedPolicy: "repetition-number", repetitions: options.repetitions, maxTurns: options.maxTurns,
      maxTokens: options.maxTokens, timeoutMs: options.timeoutMs, cache: options.cache, modelOptions: options.modelOptions, cases: options.selected },
    scope: "Real metrics plugin and explicitly loaded skill. SDK registration wrapper stubbed. Native OpenClaw routing, skill selection, full prompts and UI are not exercised.",
  };
  json(join(options.output, "manifest.json"), manifest);
  const summaries = [];
  for (const id of options.selected) {
    for (let repetition = 1; repetition <= options.repetitions; repetition++) {
      const summary = await runCase(options, replayCases.find(item => item.id === id), repetition, tools, skill);
      summaries.push(summary);
      json(join(options.output, "summaries.json"), summaries);
      console.log(JSON.stringify({ case: id, repetition, stop: summary.stop, toolCalls: summary.toolCalls, answerReview: summary.answerReview }));
    }
  }
  return summaries;
}

export function compareRuns(leftPath, rightPath) {
  const read = (dir, name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
  const left = read(leftPath, "manifest.json"), right = read(rightPath, "manifest.json");
  for (const key of ["schemaVersion", "mode", "runnerSha256", "suiteSha256", "fixture", "fixedTime", "node", "model", "modelUrl", "modelRevision", "serverRevision", "settings"]) {
    assert.deepEqual(left[key], right[key], `Not a matched harness comparison: ${key} differs`);
  }
  const a = read(leftPath, "summaries.json"), b = read(rightPath, "summaries.json");
  const expected = left.settings.cases.flatMap(id => Array.from({ length: left.settings.repetitions }, (_, i) => `${id}:${i + 1}`));
  const index = list => new Map(list.map(item => [`${item.case}:${item.repetition}`, item]));
  const ai = index(a), bi = index(b);
  for (const [items, map] of [[a, ai], [b, bi]]) {
    assert.equal(items.length, expected.length, "Incomplete experiment");
    assert.equal(map.size, expected.length, "Duplicate case/repetition");
    assert.ok(expected.every(key => map.has(key)), "Missing case/repetition");
  }
  return { left: { path: resolve(leftPath), manifest: left }, right: { path: resolve(rightPath), manifest: right },
    interpretation: "Matched execution comparison only. Every answer requires the documented factual review; completion is not correctness. Unrecorded model/server revisions limit reproducibility.",
    rows: expected.map(key => ({ key, baseline: ai.get(key), candidate: bi.get(key) })) };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "compare" && args.length === 2) {
    console.log(JSON.stringify(compareRuns(...args), null, 2));
  } else if (command === "run") {
    const rows = await runSuite(parseOptions(args));
    // Distinguish unfinished/no-investigation runs from transport success. This
    // exit status still does not assert that the final answer is accurate.
    if (rows.some(row => !row.completed || !row.investigated)) process.exitCode = 1;
  } else {
    throw new Error("Usage: node metric-history-replay.mjs run --source REPO --prometheus http://127.0.0.1:19093 --model-url URL/v1 --model MODEL_ID --output NEW_DIR [--case all --repetitions 3 --max-turns 24 --cache normal]; or compare BASELINE_DIR CANDIDATE_DIR");
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
