// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { toolAccess, toolRequiresEdit } from "../files/openclaw-seed/extensions/automation-context.ts";

const plugin = readFileSync(
  new URL("../files/openclaw-seed/extensions/bcm/index.ts", import.meta.url),
  "utf8",
);
const adapter = readFileSync(new URL("../files/bcm-mcp-ssh-server.py", import.meta.url), "utf8");

test("runs BCM tools locally and sends command execution over SSH", () => {
  assert.match(adapter, /from bcm_mcp_tools\.server import BCMServer/);
  assert.doesNotMatch(adapter, /SSHTunnelManager|install_server|bcm-mcp-tools-install/);
  assert.match(plugin, /context\.ssh_host = config\.headHost/);
  assert.doesNotMatch(plugin, /hostname: config\.headHost/);
});

test("does not permit BCM configuration to disable TLS verification", () => {
  const manifest = JSON.parse(readFileSync(
    new URL("../files/openclaw-seed/extensions/bcm/openclaw.plugin.json", import.meta.url),
  ));
  assert.equal(manifest.configSchema.properties.allowInsecureTls, undefined);
  assert.equal(manifest.uiHints.allowInsecureTls, undefined);
  assert.doesNotMatch(plugin, /NODE_TLS_REJECT_UNAUTHORIZED|allowInsecureTls/);
});

test("keeps readonly and admin CMSH on separate tools and identities", () => {
  assert.match(plugin, /name: "bcm_execute_cmsh"[\s\S]*?"execute_cmsh"/);
  assert.match(plugin, /name: "bcm_execute_cmsh_admin"[\s\S]*?"execute_cmsh_admin"/);
  assert.match(plugin, /if \(config\.editEnabled && config\.cmshEnabled\) registerTool/);
  assert.doesNotMatch(plugin, /classifyCmshRequest/);
  assert.doesNotMatch(plugin, /request\.mutating/);
});

test("requires approval for BCM mutation tools", () => {
  const start = plugin.indexOf("api.registerTrustedToolPolicy");
  const hook = plugin.slice(start, plugin.indexOf("registerTool({", start));
  assert.match(hook, /bcm_add_note.*bcm_execute_cmsh_admin.*bcm_remove_note/s);
  assert.match(hook, /requireApproval:/);
  assert.match(hook, /timeoutBehavior: "deny"/);
  assert.doesNotMatch(hook, /bcm_execute_cmsh"/);
});

test("uses per-session Auto to skip BCM approvals without weakening automation", () => {
  assert.match(plugin, /contextSkipsApproval\(context\)/);
  assert.match(plugin, /requestIdentityApproval\(context, approval\)/);
  assert.match(plugin, /isReadonlyAutomationSession\(context\.sessionKey\)/);
});

test("retains the authenticated admin backend without readonly fallback", () => {
  assert.match(adapter, /def _run_cmsh_admin/);
  assert.match(adapter, /MOSAIC_BCM_CMSH_ADMIN_ENABLED/);
  assert.match(adapter, /StaticTokenVerifier/);
  assert.doesNotMatch(adapter, /_run_cmsh_admin[\s\S]*?su\s+-/);
});

const redfishToolNames = [
  "bcm_redfish_system_summary",
  "bcm_redfish_thermal",
  "bcm_redfish_power",
  "bcm_redfish_sel",
  "bcm_redfish_firmware",
  "bcm_redfish_get",
];

test("classifies every registered Redfish tool as read-only in the global session policy", () => {
  for (const name of redfishToolNames) {
    assert.equal(toolAccess(name), "read", name);
    assert.equal(toolRequiresEdit(name), false, name);
  }
});

async function loadBcmPlugin() {
  const { registerHooks } = await import("node:module");
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "openclaw/plugin-sdk/plugin-entry") return {
        url: "data:text/javascript,export const definePluginEntry = entry => entry;", shortCircuit: true,
      };
      return nextResolve(specifier, context);
    },
  });
  try {
    return (await import("../files/openclaw-seed/extensions/bcm/index.ts")).default;
  } finally {
    hooks.deregister();
  }
}

function registerBcm(plugin, pluginConfig) {
  const tools = new Map();
  let policy;
  plugin.register({
    pluginConfig: { cmshEnabled: true, ...pluginConfig },
    session: { state: { registerSessionExtension() {} } },
    registerTrustedToolPolicy: value => { policy = value; },
    registerTool: tool => tools.set(tool.name, tool),
  });
  return { tools, policy };
}

test("registers read-only Redfish tools only when enabled", async () => {
  const plugin = await loadBcmPlugin();
  const disabled = registerBcm(plugin, {});
  assert.deepEqual(redfishToolNames.filter(name => disabled.tools.has(name)), []);
  const enabled = registerBcm(plugin, { redfishEnabled: true });
  assert.deepEqual(redfishToolNames.filter(name => enabled.tools.has(name)), redfishToolNames);
  const manifest = JSON.parse(readFileSync(
    new URL("../files/openclaw-seed/extensions/bcm/openclaw.plugin.json", import.meta.url),
  ));
  for (const name of redfishToolNames) assert.ok(manifest.contracts.tools.includes(name), name);
  assert.equal(manifest.configSchema.properties.redfishEnabled.type, "boolean");
});

test("never treats Redfish tools as mutations", async () => {
  const plugin = await loadBcmPlugin();
  const { policy } = registerBcm(plugin, { redfishEnabled: true, editEnabled: true });
  const automation = "agent:default:mosaic-automation-alert-node-down";
  assert.equal((await policy.evaluate({ toolName: "bcm_add_note", toolCallId: "call-0", params: {} }, { sessionKey: automation })).block, true);
  for (const toolName of redfishToolNames) {
    for (const sessionKey of ["agent:default:main", automation]) {
      assert.equal(await policy.evaluate({ toolName, toolCallId: "call-1", params: {} }, { sessionKey }), undefined);
    }
  }
});

test("surfaces Redfish policy refusals and validates hostnames before calling the backend", async () => {
  const plugin = await loadBcmPlugin();
  const { tools } = registerBcm(plugin, { redfishEnabled: true, mcpUrl: "http://bcm.test/mcp", authToken: "token" });
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/api/subagents/events")) return new Response("{}");
    const request = JSON.parse(init.body);
    calls.push(request.params);
    const payload = request.params.arguments.path === "/redfish/v1/AccountService"
      ? { error: "/redfish/v1/AccountService is not permitted by the read-only Redfish policy", status: 403 }
      : { hostname: request.params.arguments.hostname, systems: [{ id: "DGX", powerState: "On", health: "OK" }] };
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }));
  };
  try {
    await assert.rejects(
      tools.get("bcm_redfish_get").execute("call-1", { hostname: "dgx-03", path: "/redfish/v1/AccountService" }),
      /Redfish request refused: .*read-only/,
    );
    const summary = await tools.get("bcm_redfish_system_summary").execute("call-2", { hostname: "dgx-03" });
    assert.equal(summary.details.systems[0].powerState, "On");
    assert.deepEqual(calls.map(call => call.name), ["redfish_get", "redfish_system_summary"]);
    for (const hostname of ["dgx-03;reboot", "../dgx", "", "10.0.0.1"]) {
      await assert.rejects(tools.get("bcm_redfish_thermal").execute("call-3", { hostname }), /hostname must be a BCM node hostname/);
    }
    await assert.rejects(tools.get("bcm_redfish_get").execute("call-4", { hostname: "dgx-03", path: "https://10.0.0.1/redfish/v1" }), /path must be/);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
