// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const chart = fileURLToPath(new URL("..", import.meta.url));
const digest = `sha256:${"a".repeat(64)}`;
const enabled = [
  "--set", "managedMcpServers.servers.example.enabled=true",
  "--set", "managedMcpServers.servers.example.image.repository=registry.example/mcp-server",
  "--set-string", `managedMcpServers.servers.example.image.digest=${digest}`,
  "--set", "managedMcpServers.servers.example.env.MCP_MODE=http",
  "--set", "managedMcpServers.servers.example.secretEnv.API_TOKEN.name=example-credentials",
  "--set", "managedMcpServers.servers.example.secretEnv.API_TOKEN.key=token",
];

function render(...args) {
  return execFileSync("helm", ["template", "mosaic", chart, "--namespace", "mosaic-test", ...args], {
    encoding: "utf8",
  });
}

test("does not deploy managed MCP servers by default", () => {
  const output = render();
  assert.doesNotMatch(output, /kind: Deployment\s+metadata:\s+name: mcp-/);
  assert.doesNotMatch(output, /"mcp":\s*{\s*"servers"/);
});

test("deploys and registers a hardened managed MCP server", () => {
  const workload = render(...enabled, "--show-only", "templates/managed-mcp-servers.yaml");
  const config = render(...enabled, "--show-only", "templates/openclaw-seed-configmap.yaml");

  assert.match(workload, new RegExp(`image: "registry\\.example/mcp-server@${digest}"`));
  assert.match(workload, /automountServiceAccountToken: false/);
  assert.match(workload, /readOnlyRootFilesystem: true/);
  assert.match(workload, /allowPrivilegeEscalation: false/);
  assert.match(workload, /capabilities:\s+drop: \["ALL"\]/);
  assert.match(workload, /name: API_TOKEN[\s\S]*?name: "example-credentials"[\s\S]*?key: "token"/);
  assert.match(workload, /kind: Service[\s\S]*?name: mcp-example[\s\S]*?type: ClusterIP/);
  assert.match(workload, /kind: NetworkPolicy[\s\S]*?podSelector:[\s\S]*?app: mcp-example[\s\S]*?from:[\s\S]*?app: openclaw/);
  assert.match(config, /"example":\{"transport":"streamable-http","url":"http:\/\/mcp-example:8080\/mcp"\}/);
});

test("passes container arguments and secret-backed native MCP headers", () => {
  const settings = [
    ...enabled,
    "--set", "managedMcpServers.servers.example.args[0]=--disable-write",
    "--set", "managedMcpServers.servers.example.mcp.headers.X-Organization=operations",
    "--set", "managedMcpServers.servers.example.mcp.secretHeaders.Authorization.name=example-caller",
    "--set", "managedMcpServers.servers.example.mcp.secretHeaders.Authorization.key=token",
    "--set-string", "managedMcpServers.servers.example.mcp.secretHeaders.Authorization.prefix=Bearer ",
    "--set", "managedMcpServers.servers.example.toolPolicy.defaultAccess=view",
  ];
  const workload = render(...settings, "--show-only", "templates/managed-mcp-servers.yaml");
  const openclaw = render(...settings, "--show-only", "templates/openclaw.yaml");
  const config = render(...settings, "--show-only", "templates/openclaw-seed-configmap.yaml");

  assert.match(workload, /args:\s+- --disable-write/);
  assert.match(openclaw, /name: MOSAIC_MCP_[A-F0-9]{16}[\s\S]*?name: "example-caller"[\s\S]*?key: "token"/);
  assert.match(config, /"headers":\{"Authorization":"Bearer \$\{MOSAIC_MCP_[A-F0-9]{16}\}","X-Organization":"operations"\}/);
  assert.match(config, /"mcpToolPolicies": \{[\s\S]*?"example": \{"defaultAccess":"view","viewTools":\[\]\}/);
});

test("mounts an optional private CA only in the managed server", () => {
  const workload = render(
    ...enabled,
    "--set", "managedMcpServers.servers.example.tls.existingSecret=example-ca",
    "--show-only", "templates/managed-mcp-servers.yaml",
  );
  const openclaw = render(
    ...enabled,
    "--set", "managedMcpServers.servers.example.tls.existingSecret=example-ca",
    "--show-only", "templates/openclaw.yaml",
  );

  assert.match(workload, /name: SSL_CERT_FILE\s+value: "\/etc\/mcp\/tls\/ca\.crt"/);
  assert.match(workload, /secretName: "example-ca"/);
  assert.doesNotMatch(openclaw, /example-ca|API_TOKEN|example-credentials/);
});

test("rejects unsafe or incomplete managed MCP definitions", () => {
  for (const [settings, expected] of [
    [[], /image\.repository is required/],
    [["managedMcpServers.servers.example.image.repository=registry.example/mcp"], /image\.digest must be a sha256 digest/],
    [["managedMcpServers.servers.example.image.repository=registry.example/mcp", `managedMcpServers.servers.example.image.digest=${digest}`, "managedMcpServers.servers.example.transport=stdio"], /transport must be streamable-http or sse/],
    [["managedMcpServers.servers.example.image.repository=registry.example/mcp", `managedMcpServers.servers.example.image.digest=${digest}`, "managedMcpServers.servers.example.toolPolicy.defaultAccess=unsafe"], /defaultAccess must be view or edit/],
  ]) {
    const args = ["template", "mosaic", chart, "--namespace", "mosaic-test", "--set", "managedMcpServers.servers.example.enabled=true"];
    for (const setting of settings) args.push("--set-string", setting);
    const result = spawnSync("helm", args, { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
});
