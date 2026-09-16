// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const chart = fileURLToPath(new URL("..", import.meta.url));
const enabled = [
  "--set", "modules.runai.enabled=true",
  "--set", "runaiMcp.baseUrl=https://runai.example.com",
  "--set", "runaiMcp.credentials.existingSecret=runai-credentials",
  "--set", "runaiMcp.tls.existingSecret=runai-ca",
];

function render(...args) {
  return execFileSync("helm", ["template", "mosaic", chart, "--namespace", "mosaic-test", ...args], { encoding: "utf8" });
}

test("keeps the Run:ai integration disabled by default", () => {
  assert.doesNotMatch(render(), /name: runai-mcp/);
});

test("deploys the pinned read-only Run:ai MCP server and OpenClaw bridge", () => {
  const output = render(...enabled);
  assert.match(output, /image: "nvcr\.io\/nvidia\/runai\/runai-mcp-server:2\.26\.27"/);
  assert.match(output, /name: RUNAI_ALLOW_WRITE_TOOLS\s+value: "false"/);
  assert.match(output, /name: RUNAI_CLIENT_ID[\s\S]*name: "runai-credentials"[\s\S]*key: "clientId"/);
  assert.match(output, /name: NODE_EXTRA_CA_CERTS\s+value: "\/etc\/runai\/tls\/ca\.crt"/);
  assert.match(output, /cp \/seed\/runai\.client\.ts \/home\/node\/\.openclaw\/extensions\/runai\/client\.ts/);
  assert.match(output, /"runai":\s*{\s*"enabled": true/);
});

test("requires the Run:ai URL and existing credential Secret", () => {
  for (const [args, expected] of [
    [["--set", "modules.runai.enabled=true"], /runaiMcp\.baseUrl is required/],
    [["--set", "modules.runai.enabled=true", "--set", "runaiMcp.baseUrl=http:\/\/runai.example.com"], /baseUrl must use HTTPS/],
    [["--set", "modules.runai.enabled=true", "--set", "runaiMcp.baseUrl=https:\/\/runai.example.com"], /credentials\.existingSecret is required/],
  ]) {
    const result = spawnSync("helm", ["template", "mosaic", chart, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
});
