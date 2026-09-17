// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const chart = fileURLToPath(new URL("..", import.meta.url));
const enabled = [
  "--set", "managedMcpServers.servers.runai.enabled=true",
  "--set", "managedMcpServers.servers.runai.env.RUNAI_BASE_URL=https://runai.example.com",
  "--set", "managedMcpServers.servers.runai.secretEnv.RUNAI_CLIENT_ID.name=runai-credentials",
  "--set", "managedMcpServers.servers.runai.secretEnv.RUNAI_CLIENT_SECRET.name=runai-credentials",
];

function render(...args) {
  return execFileSync("helm", ["template", "mosaic", chart, "--namespace", "mosaic-test", ...args], {
    encoding: "utf8",
  });
}

test("does not deploy Run:ai by default", () => {
  assert.doesNotMatch(render(), /name: mcp-runai/);
});

test("implements Run:ai through the managed MCP module", () => {
  const workload = render(...enabled, "--show-only", "templates/managed-mcp-servers.yaml");
  const config = render(...enabled, "--show-only", "templates/openclaw-seed-configmap.yaml");

  assert.match(workload, /image: "nvcr\.io\/nvidia\/runai\/runai-mcp-server@sha256:4dfceb98443643f165136006a17b5488da6a98bdc5a5a146038accac305c3af0"/);
  assert.match(workload, /name: RUNAI_ALLOW_WRITE_TOOLS\s+value: "false"/);
  assert.match(workload, /name: RUNAI_CLIENT_ID[\s\S]*?name: "runai-credentials"[\s\S]*?key: "clientId"/);
  assert.match(workload, /name: RUNAI_CLIENT_SECRET[\s\S]*?name: "runai-credentials"[\s\S]*?key: "clientSecret"/);
  assert.match(config, /"runai":\{"transport":"streamable-http","url":"http:\/\/mcp-runai:8080\/mcp"\}/);
  assert.match(config, /"runai": \{"defaultAccess":"view","viewTools":\[\]\}/);
  assert.doesNotMatch(config, /RUNAI_CLIENT_ID|RUNAI_CLIENT_SECRET|runai-credentials/);
});

test("rejects unsafe Run:ai overrides", () => {
  for (const [setting, expected] of [
    ["managedMcpServers.servers.runai.env.RUNAI_BASE_URL=http://runai.example.com", /RUNAI_BASE_URL must be an HTTPS URL/],
    ["managedMcpServers.servers.runai.env.RUNAI_ALLOW_WRITE_TOOLS=true", /RUNAI_ALLOW_WRITE_TOOLS must remain false/],
    ["managedMcpServers.servers.runai.env.RUNAI_MCP_LISTEN_PORT=9000", /transport and listen port must match/],
  ]) {
    const result = spawnSync("helm", ["template", "mosaic", chart, "--namespace", "mosaic-test", ...enabled, "--set-string", setting], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
});
