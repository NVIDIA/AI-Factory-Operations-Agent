// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const chart = fileURLToPath(new URL("..", import.meta.url));
const slackManifest = fileURLToPath(new URL("../profiles/slack-app-manifest.json", import.meta.url));
const slackEnterprisePatch = fileURLToPath(
  new URL("../files/openclaw-seed/slack-enterprise-grid-patch.mjs", import.meta.url),
);

function render(...args) {
  return execFileSync("helm", ["template", "mosaic", chart, "--namespace", "mosaic-test", ...args], {
    encoding: "utf8",
  });
}

test("renders only official OpenClaw and OpenShell runtime images", () => {
  const output = render();
  for (const image of [
    "ghcr.io/openclaw/openclaw:2026.6.6",
    "ghcr.io/nvidia/openshell/gateway:0.0.75",
    "ghcr.io/nvidia/openshell/supervisor:0.0.75",
    "ghcr.io/nvidia/openshell-community/sandboxes/base@sha256:aeef1c63f00e2913ea002ccb3aaf925f338b5c5d70e63576f0d95c16a138044e",
  ]) {
    assert.ok(output.includes(image), "missing image " + image);
  }
  assert.doesNotMatch(output, /nvcr\.io\/[^\s"']*\/(?:nemoclaw|openshell)/);
  assert.doesNotMatch(output, /privileged:\s*true/);
  assert.doesNotMatch(output, /nvidia-openshell|backend["']?:\s*["']nemoclaw/);
});

test("pins every default runtime image", () => {
  const output = render();
  assert.ok(
    output.includes(
      "vllm/vllm-openai@sha256:251eba5cc7c12fed0b75da22a9240e582b1c9e39f6fbc064f86781b963bd814f",
    ),
  );
  assert.doesNotMatch(output, /image:\s*["']?\S+:latest(?:["']|\s|$)/);
});

test("renders the OpenShell backend with mTLS under XDG_CONFIG_HOME", () => {
  const output = render();
  assert.match(output, /"backend": "openshell"/);
  assert.match(output, /name: openshell-client-tls/);
  assert.match(
    output,
    /mountPath: \/home\/node\/\.openclaw\/\.config\/openshell\/gateways\/mosaic-openshell\/mtls/,
  );
  assert.match(output, /value: "https:\/\/mosaic-openshell:8080"/);
});

test("installs the verified OpenShell package through OpenClaw", () => {
  const output = render("--show-only", "templates/openclaw.yaml");
  assert.match(output, /node \/app\/dist\/index\.js plugins install \/openshell-plugin --force/);
  assert.doesNotMatch(output, /cp -R "\$package"\/\./);
});

test("does not render Slack runtime behavior when disabled", () => {
  const output = render();
  assert.doesNotMatch(output, /"maxConcurrent": 8/);
  assert.doesNotMatch(output, /"dmScope": "per-channel-peer"/);
  assert.doesNotMatch(output, /"stuckSessionWarnMs": 60000/);
  assert.doesNotMatch(output, /slack-enterprise-grid-patch\.mjs/);
  assert.doesNotMatch(output, /init-slack-plugin|SLACK_(?:BOT|APP)_TOKEN/);
});

test("renders native Slack Socket Mode with isolated execution", () => {
  const output = render(
    "--set",
    "openclaw.slack.enabled=true",
    "--set",
    "openclaw.slack.existingSecret=mosaic-slack",
    "--set",
    "openclaw.slack.allowedUserIds[0]=U12345678",
  );
  assert.match(output, /"backend": "openshell"/);
  assert.match(output, /"mode": "socket"/);
  assert.match(output, /"dmPolicy": "allowlist"/);
  assert.match(output, /"allowFrom": \["U12345678"\]/);
  assert.match(output, /"groupEnabled": false/);
  assert.match(output, /"replyToModeByChatType": \{"channel":"off","direct":"off","group":"off"\}/);
  assert.match(output, /"streaming": \{"mode":"partial","nativeTransport":true\}/);
  assert.match(output, /"maxConcurrent": 8/);
  assert.match(output, /"dmScope": "per-channel-peer"/);
  assert.match(output, /"stuckSessionAbortMs": 150000/);
  assert.match(output, /"byChannel": \{\s*"slack": "followup"/);
  assert.match(output, /name: init-slack-plugin[\s\S]*@openclaw\/slack@2026\.6\.6.*--force/);
  assert.match(output, /node \/seed\/slack-enterprise-grid-patch\.mjs/);
  assert.match(output, /name: "mosaic-slack"[\s\S]*key: "SLACK_BOT_TOKEN"/);
  assert.match(output, /name: "mosaic-slack"[\s\S]*key: "SLACK_APP_TOKEN"/);
  assert.doesNotMatch(output, /xox[baprs]-|xapp-/);
});

test("restricts Slack channel mentions to approved users", () => {
  const output = render(
    "--set",
    "openclaw.slack.enabled=true",
    "--set",
    "openclaw.slack.existingSecret=mosaic-slack",
    "--set",
    "openclaw.slack.allowedUserIds[0]=U12345678",
    "--set",
    "openclaw.slack.channelMentionsEnabled=true",
  );
  assert.match(output, /"groupPolicy": "allowlist"/);
  assert.match(output, /"\*": \{\s*"enabled": true,\s*"requireMention": true,\s*"users": \["U12345678"\]/);
});

test("configures Slack group DMs, replies, and streaming", () => {
  const output = render(
    "--set",
    "openclaw.slack.enabled=true",
    "--set",
    "openclaw.slack.existingSecret=mosaic-slack",
    "--set",
    "openclaw.slack.allowedUserIds[0]=U12345678",
    "--set",
    "openclaw.slack.groupDmsEnabled=true",
    "--set",
    "openclaw.slack.replyToModeByChatType.direct=all",
    "--set",
    "openclaw.slack.replyToModeByChatType.group=all",
    "--set",
    "openclaw.slack.replyToModeByChatType.channel=all",
    "--set-string",
    "openclaw.slack.streaming.mode=off",
    "--set",
    "openclaw.slack.streaming.nativeTransport=false",
  );
  assert.match(output, /"groupEnabled": true/);
  assert.match(output, /"replyToModeByChatType": \{"channel":"all","direct":"all","group":"all"\}/);
  assert.match(output, /"streaming": \{"mode":"off","nativeTransport":false\}/);
});

test("rejects incomplete native Slack configuration", () => {
  for (const args of [
    ["--set", "openclaw.slack.enabled=true"],
    [
      "--set",
      "openclaw.slack.enabled=true",
      "--set",
      "openclaw.slack.existingSecret=mosaic-slack",
    ],
  ]) {
    const result = spawnSync(
      "helm",
      ["template", "mosaic", chart, "--namespace", "mosaic-test", ...args],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
  }
});

test("provides a Slack app manifest for approved DMs and mentions", () => {
  const manifest = JSON.parse(readFileSync(slackManifest, "utf8"));
  assert.equal(manifest.display_information.name, "mosaic");
  assert.equal(manifest.features.bot_user.display_name, "mosaic");
  assert.match(manifest.display_information.description, /approved users/);
  assert.match(manifest.display_information.description, /Contact .+ for access/);
  assert.deepEqual(manifest.oauth_config.scopes.bot, [
    "app_mentions:read",
    "channels:history",
    "chat:write",
    "groups:history",
    "im:history",
    "im:read",
    "im:write",
    "mpim:history",
    "mpim:read",
    "mpim:write",
  ]);
  assert.deepEqual(manifest.settings.event_subscriptions.bot_events, [
    "app_mention",
    "message.im",
    "message.mpim",
  ]);
  assert.equal(manifest.settings.socket_mode_enabled, true);
  assert.equal(manifest.features.app_home.home_tab_enabled, false);
  assert.equal(manifest.oauth_config.redirect_urls, undefined);
  assert.deepEqual(manifest.settings.interactivity, { is_enabled: false });
});

test("patches Slack Enterprise Grid workspace events without weakening app checks", () => {
  const dir = mkdtempSync(join(tmpdir(), "mosaic-slack-patch-"));
  const provider = join(dir, "provider.js");
  writeFileSync(
    provider,
    `\t\tconst incomingTeamId = typeof raw.team_id === "string" ? raw.team_id : typeof raw.team?.id === "string" ? raw.team.id : "";\n` +
      `\t\tif (params.apiAppId && incomingApiAppId && incomingApiAppId !== params.apiAppId) {}\n` +
      `\t\tif (params.teamId && incomingTeamId && incomingTeamId !== params.teamId) {}`,
  );
  execFileSync("node", [slackEnterprisePatch, provider]);
  execFileSync("node", [slackEnterprisePatch, provider]);
  const patched = readFileSync(provider, "utf8");
  rmSync(dir, { recursive: true });
  assert.match(patched, /incomingEnterpriseId/);
  assert.match(patched, /incomingEnterpriseId !== params\.teamId/);
  assert.match(patched, /incomingApiAppId !== params\.apiAppId/);
});

test("renders named external Kubernetes clusters from Secrets", () => {
  const output = render(
    "--set",
    "kubernetes.clusters[0].name=remote",
    "--set",
    "kubernetes.clusters[0].kubeconfigSecretRef.name=remote-kubeconfig",
    "--set",
    "kubernetes.clusters[0].kubeconfigSecretRef.key=config",
  );
  assert.ok(output.includes("name: kubernetes-external-0"));
  assert.ok(output.includes('secretName: "remote-kubeconfig"'));
  assert.ok(output.includes('"remote":"/var/run/mosaic-kubernetes-external/remote/config"'));
});

test("renders read-only Kubernetes RBAC including metrics without Secrets or pod execution", () => {
  const output = render("--show-only", "templates/rbac.yaml");
  assert.match(output, /apiGroups: \["metrics\.k8s\.io"\][\s\S]*resources: \["nodes", "pods"\][\s\S]*verbs: \["get", "list"\]/);
  assert.doesNotMatch(output, /resources: \[[^\]]*"secrets"/);
  assert.doesNotMatch(output, /resources: \[[^\]]*"pods\/exec"/);
  assert.doesNotMatch(output, /verbs: \[[^\]]*"(?:create|delete|patch|update)"/);
});

test("installs a checksum-pinned upstream kubectl binary", () => {
  const output = render("--show-only", "templates/openclaw.yaml");
  assert.match(output, /https:\/\/dl\.k8s\.io\/release\/v1\.34\.1\/bin\/linux\/\$architecture\/kubectl/);
  assert.match(output, /7721f265e18709862655affba5343e85e1980639395d5754473dafaadcaa69e3/);
  assert.match(output, /420e6110e3ba7ee5a3927b5af868d18df17aae36b720529ffa4e9e945aa95450/);
  assert.doesNotMatch(output, /registry\.k8s\.io\/kubectl/);
});

test("packages every Kubernetes plugin module into the OpenClaw seed", () => {
  const seed = render("--show-only", "templates/openclaw-seed-configmap.yaml");
  const deployment = render("--show-only", "templates/openclaw.yaml");
  for (const module of ["index", "policy", "runner"]) {
    assert.ok(seed.includes(`kubernetes.${module}.ts: |-`));
    assert.ok(deployment.includes(`cp /seed/kubernetes.${module}.ts /home/node/.openclaw/extensions/kubernetes/${module}.ts`));
  }
});

test("rejects an unregistered default Kubernetes cluster", () => {
  const result = spawnSync(
    "helm",
    ["template", "mosaic", chart, "--namespace", "mosaic-test", "--set", "kubernetes.defaultCluster=missing"],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /defaultCluster "missing" is not registered/);
});
