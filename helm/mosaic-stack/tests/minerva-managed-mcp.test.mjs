// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const chart = fileURLToPath(new URL("..", import.meta.url));
const enabled = [
  "--set", "managedMcpServers.servers.minerva.enabled=true",
  "--set", "managedMcpServers.servers.minerva.image.repository=registry.example/minerva",
  "--set", `managedMcpServers.servers.minerva.image.digest=sha256:${"b".repeat(64)}`,
  "--set", "managedMcpServers.servers.minerva.port=8123",
  "--set", "managedMcpServers.servers.minerva.path=/minerva/mcp",
];
const render = (...args) => execFileSync("helm", ["template", "aifoa", chart, ...args], { encoding: "utf8" });

function block(output, key) {
  const lines = output.split("\n");
  const start = lines.findIndex(line => line.startsWith(`  ${key}: |`));
  assert.ok(start >= 0, `Missing ConfigMap entry: ${key}`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line && !line.startsWith("    ")) break;
    body.push(line.slice(4));
  }
  return body.join("\n");
}

test("leaves the Minerva workload and skill absent unless configured", () => {
  const output = render();
  assert.doesNotMatch(output, /name: mcp-minerva\b|minerva\.SKILL\.md:/);
  assert.ok(!JSON.parse(block(output, "openclaw.json")).agents.defaults.skills.includes("minerva"));
});

test("deploys the data server and registers the read-only tools and discovery skill", () => {
  const output = render(...enabled);
  const config = JSON.parse(block(output, "openclaw.json"));
  assert.match(output, /runAsUser: 65532/);
  assert.deepEqual(config.mcp.servers.minerva, { transport: "streamable-http", url: "http://mcp-minerva:8123/minerva/mcp" });
  assert.deepEqual(config.plugins.entries["automation-guard"].config.mcpToolPolicies.minerva, {
    defaultAccess: "edit",
    viewTools: ["list_capabilities", "get_capability_schema", "druid_query", "get_neo4j_schema", "neo4j_query"],
  });
  assert.match(output, /cp \/seed\/minerva\.SKILL\.md/);
});

test("installs the same discovery skill for an external Minerva endpoint", () => {
  const output = render("--set", "externalMcpServers.minerva.url=https://minerva.example.com/minerva/mcp");
  assert.match(output, /minerva\.SKILL\.md:/);
  assert.match(output, /cp \/seed\/minerva\.SKILL\.md/);
  assert.doesNotMatch(output, /name: mcp-minerva\b/);
});

test("preloads configured Minerva guidance without truncating other bootstrap instructions", () => {
  const source = readFileSync(new URL("../files/openclaw-seed/skills/minerva/SKILL.md", import.meta.url), "utf8").trim();
  for (const settings of [enabled, ["--set", "externalMcpServers.minerva.url=https://minerva.example.com/minerva/mcp"]]) {
    const output = render(...settings, "--set", "openclaw.bootstrapSkills[0]=gpu-networking");
    const config = JSON.parse(block(output, "openclaw.json"));
    const instructions = block(output, "AGENTS.md");
    assert.ok(instructions.includes(source));
    assert.ok(config.agents.defaults.bootstrapMaxChars > instructions.length);
    assert.ok(config.agents.defaults.skills.includes("minerva"));
    const networking = readFileSync(new URL("../files/openclaw-seed/skills/gpu-networking/SKILL.md", import.meta.url), "utf8").trim();
    assert.ok(instructions.includes(networking));
  }
});
