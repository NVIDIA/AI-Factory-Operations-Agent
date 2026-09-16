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
];

function render(...args) {
  return execFileSync("helm", ["template", "mosaic", chart, "--namespace", "mosaic-test", ...args], {
    encoding: "utf8",
  });
}

test("does not deploy Run:ai by default", () => {
  const output = render();
  assert.doesNotMatch(output, /kind: Deployment\s+metadata:\s+name: runai-mcp/);
  assert.doesNotMatch(output, /"runai": \{/);
});

test("connects the public read-only Run:ai server through standard MCP", () => {
  const server = render(...enabled, "--show-only", "templates/runai-mcp.yaml");
  const config = render(...enabled, "--show-only", "templates/openclaw-seed-configmap.yaml");

  assert.match(server, /image: "nvcr\.io\/nvidia\/runai\/runai-mcp-server@sha256:4dfceb98443643f165136006a17b5488da6a98bdc5a5a146038accac305c3af0"/);
  assert.match(server, /automountServiceAccountToken: false/);
  assert.match(server, /name: RUNAI_ALLOW_WRITE_TOOLS\s+value: "false"/);
  assert.match(server, /name: RUNAI_CLIENT_ID[\s\S]*?name: "runai-credentials"[\s\S]*?key: "clientId"/);
  assert.match(server, /name: RUNAI_CLIENT_SECRET[\s\S]*?name: "runai-credentials"[\s\S]*?key: "clientSecret"/);
  assert.match(config, /"runai": \{\s+"url": "http:\/\/runai-mcp:8080\/mcp",\s+"transport": "streamable-http"/);
});

test("keeps Run:ai credentials and custom CA out of OpenClaw", () => {
  const openclaw = render(
    ...enabled,
    "--set", "runaiMcp.tls.existingSecret=runai-ca",
    "--show-only", "templates/openclaw.yaml",
  );
  const server = render(
    ...enabled,
    "--set", "runaiMcp.tls.existingSecret=runai-ca",
    "--show-only", "templates/runai-mcp.yaml",
  );

  assert.doesNotMatch(openclaw, /RUNAI_CLIENT_ID|RUNAI_CLIENT_SECRET|runai-ca|SSL_CERT_FILE/);
  assert.match(server, /name: SSL_CERT_FILE\s+value: "\/etc\/runai\/tls\/ca\.crt"/);
  assert.match(server, /secretName: "runai-ca"/);
});

test("rejects incomplete or insecure Run:ai configuration", () => {
  for (const [settings, expected] of [
    [[], /runaiMcp\.baseUrl is required/],
    [["modules.execution.enabled=false"], /requires modules\.execution\.enabled=true/],
    [["openclaw.enabled=false"], /requires openclaw\.enabled=true/],
    [["runaiMcp.baseUrl=http://runai.example.com"], /runaiMcp\.baseUrl must use HTTPS/],
    [["runaiMcp.baseUrl=https://runai.example.com"], /runaiMcp\.credentials\.existingSecret is required/],
  ]) {
    const args = ["template", "mosaic", chart, "--namespace", "mosaic-test", "--set", "modules.runai.enabled=true"];
    for (const setting of settings) args.push("--set", setting);
    const result = spawnSync("helm", args, { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
});
