// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const extension = new URL("../files/openclaw-seed/extensions/bcm/index.ts", import.meta.url);
const source = readFileSync(extension, "utf8")
  .replace('import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";', "const definePluginEntry = value => value;")
  .replace('"../automation-context.ts"', JSON.stringify(new URL("../automation-context.ts", extension).href))
  .replace('"../mutation-ledger.ts"', JSON.stringify(new URL("../mutation-ledger.ts", extension).href));
const { default: plugin } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString("base64")}`);

function tools(config) {
  const registered = new Map();
  plugin.register({
    pluginConfig: config,
    session: { state: { registerSessionExtension() {} } },
    registerTrustedToolPolicy() {},
    registerTool(tool) { registered.set(tool.name, tool); },
  });
  return registered;
}

test("exposes head-node scripts in SSH mode independently of CMSH and edit", () => {
  const config = { mcpMode: "ssh-adapter", cmshEnabled: false, editEnabled: false };
  assert.ok(tools(config).has("bcm_execute_headnode_script"));
  assert.equal(tools({ ...config, mcpMode: "direct" }).has("bcm_execute_headnode_script"), false);
  assert.equal(tools({ ...config, disabledTools: ["bcm_execute_headnode_script"] }).has("bcm_execute_headnode_script"), false);
});

test("forwards selected scripts with authentication without caching or telemetry", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, ...options, payload: JSON.parse(options.body) });
    return new Response(JSON.stringify({ result: { content: [{ type: "text", text: `result-${calls.length}` }] } }));
  });
  const tool = tools({ mcpMode: "ssh-adapter", mcpUrl: "https://bcm.example/mcp", authToken: "test-token" })
    .get("bcm_execute_headnode_script");
  const scripts = tool.parameters.properties.script.enum;
  assert.ok(scripts.length > 0);
  for (const script of scripts) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await tool.execute("call", { script });
      assert.equal(result.content[0].text, `result-${calls.length}`);
      const call = calls.at(-1);
      assert.equal(call.url, "https://bcm.example/mcp");
      assert.equal(call.headers.Authorization, "Bearer test-token");
      assert.deepEqual(call.payload.params, { name: "execute_headnode_script", arguments: { script } });
    }
  }
  assert.equal(calls.length, scripts.length * 2);
});
