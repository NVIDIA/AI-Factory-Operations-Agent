// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { registerHooks } from "node:module";

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "openclaw/plugin-sdk/plugin-entry") return {
      url: "data:text/javascript,export const definePluginEntry = entry => entry;", shortCircuit: true,
    };
    return nextResolve(specifier, context);
  },
});
const { default: plugin } = await import("../../helm/mosaic-stack/files/openclaw-seed/extensions/bcm/index.ts");
hooks.deregister();
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => String(url).includes("/api/subagents/events")
  ? Promise.resolve(Response.json({})) : realFetch(url, init);
const tools = new Map();
plugin.register({
  pluginConfig: { mcpMode: "external", mcpUrl: process.env.BCM_TEST_URL + "/mcp", authToken: process.env.BCM_TEST_TOKEN },
  session: { state: { registerSessionExtension() {} } },
  registerTrustedToolPolicy() {},
  registerTool(tool) { tools.set(tool.name, tool); },
});
const diagnostic = await tools.get("bcm_execute_tool").execute("diagnostic", { tool_id: "system.uname", tool_kwargs: { args: ["-s"] } });
assert.ok(JSON.stringify(diagnostic.details).includes("Linux"));
const search = await tools.get("bcm_search_tools").execute("search", { query: "uname" });
assert.ok(JSON.stringify(search.details).includes("system.uname"));
console.log("Mosaic agent client diagnostic and search pass.");
