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

test("startup-loads the Kubernetes approval hook", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../files/openclaw-seed/extensions/kubernetes/openclaw.plugin.json", import.meta.url)),
  );
  assert.equal(manifest.activation?.onStartup, true);
  assert.deepEqual(manifest.contracts?.trustedToolPolicies, ["kubernetes-access"]);
});

test("startup-loads one shared diagnostic policy", () => {
  const seed = render("--show-only", "templates/openclaw-seed-configmap.yaml");
  const runtime = render("--show-only", "templates/openclaw.yaml");
  assert.match(seed, /diagnostic-policy\.ts/);
  assert.match(runtime, /cp \/seed\/diagnostic-policy\.ts \/home\/node\/\.openclaw\/extensions\/diagnostic-policy\.ts/);
});

test("startup-loads the remote SSH approval hook", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../files/openclaw-seed/extensions/remote-ssh/openclaw.plugin.json", import.meta.url)),
  );
  assert.equal(manifest.activation?.onStartup, true);
  assert.deepEqual(manifest.contracts?.trustedToolPolicies, ["remote-ssh-access"]);
});

test("startup-loads the automation read-only guard", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../files/openclaw-seed/extensions/automation-guard/openclaw.plugin.json", import.meta.url)),
  );
  assert.equal(manifest.activation?.onStartup, true);
  assert.deepEqual(manifest.contracts?.trustedToolPolicies, ["session-access"]);
  const seed = render("--show-only", "templates/openclaw-seed-configmap.yaml");
  assert.match(seed, /"automation-guard":\s*{\s*"enabled": true,\s*"hooks":\s*{\s*"allowConversationAccess": true\s*},\s*"config":\s*{\s*"editEnabled": false/);
  assert.match(render("--set", "modules.edit.enabled=true", "--show-only", "templates/openclaw-seed-configmap.yaml"), /"editEnabled": true/);
  assert.match(seed, /automation-context\.ts: \|-/);
  const runtime = render("--show-only", "templates/openclaw.yaml");
  assert.match(runtime, /cp \/seed\/automation-guard\.index\.ts/);
  assert.doesNotMatch(runtime, /cp \/seed\/(?:bcm|kubernetes)-policy\.ts/);
});

function render(...args) {
  return execFileSync("helm", ["template", "mosaic", chart, "--namespace", "mosaic-test", ...args], {
    encoding: "utf8",
  });
}

test("renders only official OpenClaw and OpenShell runtime images", () => {
  const output = render();
  for (const image of [
    "ghcr.io/openclaw/openclaw:2026.6.10",
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

test("renders namespace labeling with the configured kubectl image", () => {
  const output = render(
    "--show-only",
    "templates/namespace-labels.yaml",
    "--set-json",
    'namespace.labels={"example.com/managed":"true"}',
  );
  assert.match(output, /image: "registry\.k8s\.io\/kubectl:v1\.30\.0"/);
  assert.match(output, /"example\.com\/managed=true"/);
});

test("pins the UI to the immutable GitLab short SHA tag", () => {
  const output = render("--show-only", "templates/mosaic-ui.yaml");
  assert.match(output, /image: "nvcr\.io\/0948643769302270\/mosaic-ui:[0-9a-f]{8}"/);
});

test("can disable thinking for an external vLLM endpoint", () => {
  const output = render(
    "--set", "llm.mode=external",
    "--set", "llm.external.baseUrl=http://vllm.example/v1",
    "--set", "llm.external.model=nemotron-super-120b",
    "--set", "llm.requestCompatibility.vllmUpstream=true",
    "--show-only", "templates/llm-compat.yaml",
  );
  assert.match(output, /name: VLLM_UPSTREAM\s+value: "true"/);
  assert.match(output, /const vllmUpstream = process\.env\.VLLM_UPSTREAM === 'true'/);
  assert.match(output, /llmMode !== 'vllm' && !vllmUpstream/);
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
  assert.match(output, /"slackEnabled": false/);
  assert.match(output, /"slackEditUserIds": \[\]/);
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
  assert.match(output, /"slackEnabled": true/);
  assert.match(output, /"slackEditUserIds": \[\]/);
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
  assert.deepEqual(manifest.settings.interactivity, { is_enabled: true });
});

test("keeps Slack messaging access broad while granting Edit to explicit identities", () => {
  const output = render(
    "--set", "modules.ui.enabled=false",
    "--set", "modules.edit.enabled=true",
    "--set", "openclaw.slack.enabled=true",
    "--set", "openclaw.slack.existingSecret=mosaic-slack",
    "--set", "openclaw.slack.allowedUserIds[0]=U11111111",
    "--set", "openclaw.slack.allowedUserIds[1]=U22222222",
    "--set", "openclaw.slack.editUserIds[0]=U22222222",
    "--set", "openclaw.slack.channelMentionsEnabled=true",
    "--set", "openclaw.slack.groupDmsEnabled=true",
  );
  assert.match(output, /"allowFrom": \["U11111111","U22222222"\]/);
  assert.match(output, /"execApprovals":\s*{\s*"enabled": true,\s*"approvers": \["U22222222"\],\s*"target": "dm"/);
  assert.match(output, /"users": \["U11111111","U22222222"\]/);
  assert.match(output, /"groupEnabled": true/);
  assert.match(output, /"slackEditUserIds": \["U22222222"\]/);
});

test("omits Slack identity and exec approval configuration when Slack is disabled", () => {
  const output = render();
  assert.doesNotMatch(output, /"channels":\s*{\s*"slack"/);
  assert.doesNotMatch(output, /"execApprovals"/);
  assert.match(output, /"slackEnabled": false/);
  assert.match(output, /"slackEditUserIds": \[\]/);
});

test("validates Slack edit identities without weakening the messaging allowlist", () => {
  for (const settings of [
    ["openclaw.slack.editUserIds[0]=U22222222"],
    [
      "modules.edit.enabled=true",
      "openclaw.slack.enabled=true",
      "openclaw.slack.existingSecret=mosaic-slack",
      "openclaw.slack.allowedUserIds[0]=U11111111",
      "openclaw.slack.editUserIds[0]=U22222222",
    ],
  ]) {
    const args = ["template", "mosaic", chart, "--namespace", "mosaic-test"];
    for (const setting of settings) args.push("--set", setting);
    const result = spawnSync("helm", args, { encoding: "utf8" });
    assert.notEqual(result.status, 0, settings.join(", "));
  }
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

test("exposes only Mosaic-owned skills to OpenClaw agents", () => {
  const output = render("--show-only", "templates/openclaw-seed-configmap.yaml");
  assert.match(
    output,
    /"skills": \[\s*"bcm",\s*"hardware-agent",\s*"iraop",\s*"observability",\s*"slurm"\s*\]/,
  );
  assert.doesNotMatch(output, /"allowBundled"/);
});

test("renders named external Kubernetes clusters from Secrets", () => {
  const output = render(
    "--set",
    "kubernetes.clusters[0].name=remote",
    "--set",
    "kubernetes.clusters[0].kubeconfigSecretRef.name=remote-kubeconfig",
    "--set",
    "kubernetes.clusters[0].kubeconfigSecretRef.key=config",
    "--set",
    "kubernetes.clusters[0].server=https://bcm-head.example.com:11443",
    "--set",
    "kubernetes.clusters[0].tlsServerName=127.0.0.1",
  );
  assert.ok(output.includes("name: kubernetes-external-0"));
  assert.ok(output.includes('secretName: "remote-kubeconfig"'));
  assert.match(output, /"remote":\{[^}]*"kubeconfig":"\/var\/run\/mosaic-kubernetes-external\/remote\/config"[^}]*"server":"https:\/\/bcm-head\.example\.com:11443"[^}]*"tlsServerName":"127\.0\.0\.1"/);
});

test("renders read-only Kubernetes RBAC including metrics without Secrets or pod execution", () => {
  const output = render("--show-only", "templates/rbac.yaml");
  assert.match(output, /apiGroups: \["metrics\.k8s\.io"\][\s\S]*resources: \["nodes", "pods"\][\s\S]*verbs: \["get", "list"\]/);
  assert.doesNotMatch(output, /resources: \[[^\]]*"secrets"/);
  assert.doesNotMatch(output, /resources: \[[^\]]*"pods\/exec"/);
  assert.doesNotMatch(output, /verbs: \[[^\]]*"(?:create|delete|patch|update)"/);
});

test("renders workload editor and pod exec RBAC for OpenClaw when edit mode is enabled", () => {
  const output = render(
    "--set",
    "modules.edit.enabled=true",
    "--set",
    "modules.terminal.enabled=true",
    "--show-only",
    "templates/rbac.yaml",
  );
  assert.match(output, /name: .*oc-editor/);
  assert.match(output, /resources: \["configmaps", "pods", "services"\]\s+verbs: \["create", "delete", "patch", "update"\]/);
  assert.match(output, /resources: \["pods\/exec"\]\s+verbs: \["create"\]/);
  assert.match(output, /resources: \["daemonsets", "deployments", "statefulsets"\]\s+verbs: \["create", "delete", "patch", "update"\]/);
  assert.match(output, /resources: \["cronjobs", "jobs"\]\s+verbs: \["create", "delete", "patch", "update"\]/);
  assert.doesNotMatch(output, /resources: \[[^\]]*"(?:secrets|clusterroles|customresourcedefinitions|serviceaccounts\/token)"/);
  const editorBinding = output.slice(output.lastIndexOf("kind: ClusterRoleBinding"));
  assert.match(editorBinding, /name: openclaw/);
  assert.doesNotMatch(editorBinding, /name: mosaic-terminal/);
});

test("binds an installer-supplied editor role without rendering a duplicate role", () => {
  const output = render(
    "--set",
    "modules.edit.enabled=true",
    "--set",
    "modules.edit.kubernetes.existingClusterRole=tenant-workload-editor",
    "--show-only",
    "templates/rbac.yaml",
  );
  assert.doesNotMatch(output, /kind: ClusterRole\s+metadata:\s+name: .*oc-editor/);
  assert.match(output, /kind: ClusterRoleBinding[\s\S]*name: tenant-workload-editor/);
});

test("seeds edit mode and approval settings into Kubernetes and BCM plugins", () => {
  const disabled = render("--show-only", "templates/openclaw-seed-configmap.yaml");
  const enabled = render(
    "--set",
    "modules.edit.enabled=true",
    "--set",
    "modules.edit.approvalTimeoutMs=45000",
    "--show-only",
    "templates/openclaw-seed-configmap.yaml",
  );
  assert.match(disabled, /"editEnabled": false/);
  assert.match(disabled, /^  mutation-ledger\.ts: \|-/m);
  assert.match(enabled, /"editEnabled": true/);
  assert.match(enabled, /"hitl": true/);
  assert.match(enabled, /"approvalTimeoutMs": 45000/);
  assert.match(enabled, /mutation-ledger\.ts: \|-/);
  assert.match(render("--show-only", "templates/openclaw.yaml"), /cp \/seed\/mutation-ledger\.ts \/home\/node\/\.openclaw\/extensions\/mutation-ledger\.ts/);
});

test("tells the assistant about session access modes only when editing is enabled", () => {
  const readonly = render();
  assert.match(readonly, /Mosaic edit mode is disabled/);
  assert.doesNotMatch(readonly, /Remote commands are permitted only/);

  const editable = render(
    "--set", "modules.edit.enabled=true",
    "--set", "modules.edit.ssh.enabled=true",
    "--set", "modules.edit.ssh.existingSecret=remote-ssh",
    "--set", "modules.edit.ssh.hosts[0].alias=worker-1",
    "--set", "modules.edit.ssh.hosts[0].address=10.0.0.7",
    "--set", "modules.edit.ssh.hosts[0].user=root",
    "--set", "modules.edit.ssh.hosts[0].port=22",
  );
  assert.match(editable, /## Session Access Modes/);
  assert.match(editable, /`mosaic_access_mode`.*authoritative/);
  assert.match(editable, /call `run_remote_ssh`/);
  assert.match(editable, /For remote host operations, call `run_remote_ssh` immediately/);
});

test("renders an authenticated BCM admin path only for BCM edit mode", () => {
  const output = render(
    "--set",
    "modules.edit.enabled=true",
    "--set",
    "modules.edit.kubernetes.enabled=false",
    "--set",
    "modules.edit.bcm.enabled=true",
    "--set",
    "bcmMcp.enabled=true",
    "--set",
    "bcmMcp.mode=ssh-adapter",
    "--set",
    "bcmMcp.headHost=bcm-head",
    "--set",
    "bcmMcp.hostSshKeySecretName=bcm-host-ssh",
  );
  assert.match(output, /apiVersion: v1\s+kind: Secret[\s\S]*name: bcm-mcp-auth/);
  assert.doesNotMatch(output, /Apache-2\.0apiVersion/);
  assert.match(output, /name: MOSAIC_BCM_CMSH_ADMIN_ENABLED\s+value: "true"/);
  assert.match(output, /name: MOSAIC_BCM_MCP_TOKEN\s+valueFrom:\s+secretKeyRef:\s+name: bcm-mcp-auth\s+key: BCM_MCP_TOKEN/);
  assert.match(output, /"authToken": "\$\{MOSAIC_BCM_MCP_TOKEN\}"/);
  assert.match(output, /"editEnabled": true/);
  assert.match(output, /bcm_execute_cmsh_admin/);
  assert.doesNotMatch(output, /"authToken": "[A-Za-z0-9]{48}"/);
});

test("keeps the managed BCM adapter read-only when edit mode is disabled", () => {
  const output = render(
    "--set",
    "bcmMcp.enabled=true",
    "--set",
    "bcmMcp.mode=ssh-adapter",
    "--set",
    "bcmMcp.headHost=bcm-head",
    "--set",
    "bcmMcp.hostSshKeySecretName=bcm-host-ssh",
  );
  assert.match(output, /name: MOSAIC_BCM_CMSH_ADMIN_ENABLED\s+value: "false"/);
  assert.match(output, /name: MOSAIC_BCM_CMSH_USERNAME\s+value: "aichatbotuser"/);
  assert.match(output, /name: MOSAIC_BCM_CMSH_PROFILE\s+value: "readonly"/);
  assert.match(output, /"editEnabled": false/);
});

test("exposes edit and HITL state to the UI without changing their defaults", () => {
  const disabled = render("--show-only", "templates/mosaic-ui.yaml");
  const enabled = render(
    "--set",
    "modules.edit.enabled=true",
    "--show-only",
    "templates/mosaic-ui.yaml",
  );
  assert.match(disabled, /name: MOSAIC_EDIT_ENABLED\s+value: "false"/);
  assert.match(disabled, /name: MOSAIC_EDIT_HITL\s+value: "true"/);
  assert.match(enabled, /name: MOSAIC_EDIT_ENABLED\s+value: "true"/);
  assert.match(enabled, /name: MOSAIC_EDIT_HITL\s+value: "true"/);
  assert.match(enabled, /name: MOSAIC_SESSION_ACCESS_PLUGINS\s+value: "automation-guard,kubernetes"/);

  const ssh = render(
    "--set", "modules.edit.enabled=true",
    "--set", "modules.edit.kubernetes.enabled=false",
    "--set", "modules.edit.ssh.enabled=true",
    "--set", "modules.edit.ssh.existingSecret=ssh-key",
    "--set", "modules.edit.ssh.hosts[0].alias=node-a",
    "--set", "modules.edit.ssh.hosts[0].address=node-a",
    "--set", "modules.edit.ssh.hosts[0].user=tester",
    "--show-only", "templates/mosaic-ui.yaml",
  );
  assert.match(ssh, /name: MOSAIC_SESSION_ACCESS_PLUGINS\s+value: "automation-guard,kubernetes,remote-ssh"/);
});

test("validates edit mode dependencies and backend configuration", () => {
  const invalid = [
    ["modules.execution.enabled=false", /requires modules\.execution\.enabled=true/],
    ["modules.ui.enabled=false", /requires modules\.ui\.enabled=true or at least one openclaw\.slack\.editUserIds entry/],
    ["modules.edit.approvalTimeoutMs=999", /must be at least 1000/],
    ["modules.edit.kubernetes.enabled=false", /requires at least one configured edit backend/],
    ["modules.kubernetes.enabled=false", /requires modules\.kubernetes\.enabled=true/],
    ["modules.edit.bcm.enabled=true", "modules.bcm.enabled=false", /requires an enabled BCM MCP service/],
    ["modules.edit.kubernetes.enabled=false", "modules.edit.bcm.enabled=true", "bcmMcp.enabled=true", /requires bcmMcp\.mode=ssh-adapter/],
    ["modules.edit.ssh.enabled=true", /existingSecret is required/],
    ["modules.edit.ssh.enabled=true", "modules.edit.ssh.existingSecret=ssh-key", /hosts must contain at least one host/],
    ["modules.edit.ssh.enabled=true", "modules.edit.ssh.existingSecret=ssh-key", "modules.edit.ssh.hosts[0].alias=-bad", "modules.edit.ssh.hosts[0].address=node004", "modules.edit.ssh.hosts[0].user=root", /alias is invalid/],
  ];
  for (const entry of invalid) {
    const expected = entry.at(-1);
    const settings = entry.slice(0, -1);
    const args = ["template", "mosaic", chart, "--namespace", "mosaic-test", "--set", "modules.edit.enabled=true"];
    for (const setting of settings) args.push("--set", setting);
    const result = spawnSync("helm", args, { encoding: "utf8" });
    assert.notEqual(result.status, 0, settings.join(", "));
    assert.match(result.stderr, expected);
  }

  const fullAuto = spawnSync(
    "helm",
    [
      "template",
      "mosaic",
      chart,
      "--namespace",
      "mosaic-test",
      "--set",
      "modules.edit.enabled=true",
      "--set",
      "modules.edit.hitl=false",
      "--set",
      "modules.ui.enabled=false",
    ],
    { encoding: "utf8" },
  );
  assert.equal(fullAuto.status, 0, fullAuto.stderr);
});

test("renders constrained remote SSH only in the OpenClaw pod", () => {
  const settings = [
    "--set", "modules.edit.enabled=true",
    "--set", "modules.edit.kubernetes.enabled=false",
    "--set", "modules.edit.ssh.enabled=true",
    "--set", "modules.edit.ssh.existingSecret=remote-node-key",
    "--set", "modules.edit.ssh.hosts[0].alias=node004",
    "--set", "modules.edit.ssh.hosts[0].address=10.0.0.4",
    "--set", "modules.edit.ssh.hosts[0].user=root",
  ];
  const output = render(...settings, "--show-only", "templates/openclaw.yaml");
  const seed = render(...settings, "--show-only", "templates/openclaw-seed-configmap.yaml");
  assert.match(output, /name: init-remote-ssh-credentials/);
  assert.match(output, /name: init-remote-ssh-credentials[\s\S]*runAsNonRoot: true[\s\S]*runAsUser: 1000/);
  assert.doesNotMatch(output, /chown 1000:1000 \/credentials/);
  assert.match(output, /secretName: "remote-node-key"/);
  assert.match(output, /mountPath: \/var\/run\/mosaic-ssh\s+readOnly: true/);
  assert.match(output, /emptyDir:\s+medium: Memory/);
  assert.doesNotMatch(output, /mountPath: \/sandbox[\s\S]*remote-ssh/);
  for (const module of ["index", "policy", "runner"]) {
    assert.ok(seed.includes(`remote-ssh.${module}.ts: |-`));
    assert.ok(output.includes(`cp /seed/remote-ssh.${module}.ts /home/node/.openclaw/extensions/remote-ssh/${module}.ts`));
  }
  assert.match(seed, /"remote-ssh":\s*{\s*"enabled": true/);
  assert.match(seed, /"alias":"node004"/);
});

test("omits remote SSH credentials and plugin files by default", () => {
  const output = render("--show-only", "templates/openclaw.yaml");
  const seed = render("--show-only", "templates/openclaw-seed-configmap.yaml");
  assert.doesNotMatch(output, /remote-ssh-(?:source|credentials)/);
  assert.doesNotMatch(seed, /remote-ssh\.index\.ts/);
});

test("omits every terminal workload resource when the module is disabled", () => {
  const output = render();
  assert.doesNotMatch(output, /(?:name|app): mosaic-terminal(?:\s|$)/);
  assert.match(output, /name: MOSAIC_TERMINAL_ENABLED\s+value: "false"/);
});

test("renders the terminal service from the UI image with isolated read-only access", () => {
  const output = render("--set", "modules.terminal.enabled=true");
  const rbac = render("--set", "modules.terminal.enabled=true", "--show-only", "templates/rbac.yaml");
  assert.match(output, /kind: ServiceAccount[\s\S]*name: mosaic-terminal/);
  assert.match(output, /kind: Deployment[\s\S]*name: mosaic-terminal/);
  assert.match(output, /kind: Service[\s\S]*name: mosaic-terminal/);
  assert.match(output, /kind: Secret[\s\S]*name: mosaic-terminal-auth/);
  assert.match(output, /command: \["node", "\/app\/frontend\/bin\/mosaic-terminal\.mjs"\]/);
  assert.match(output, /image: "nvcr\.io\/0948643769302270\/mosaic-ui:[^"]+"/);
  assert.match(output, /name: MOSAIC_TERMINAL_URL\s+value: "http:\/\/mosaic-terminal:3002"/);
  assert.match(output, /name: mosaic-terminal[\s\S]*namespace: mosaic-test[\s\S]*name: .*oc-reader/);
  assert.match(output, /requiredDuringSchedulingIgnoredDuringExecution:[\s\S]*app: openclaw/);
  assert.match(output, /curl -fsSL --retry 5 --retry-all-errors -o \/tools\/kubectl \\\s+"https:\/\/dl\.k8s\.io\/release\/v1\.34\.1\/bin\/linux\/\$architecture\/kubectl"/);
  assert.doesNotMatch(output, /registry\.k8s\.io\/kubectl/);
  assert.doesNotMatch(rbac, /resources: \[[^\]]*"secrets"/);
  assert.doesNotMatch(rbac, /resources: \[[^\]]*"pods\/exec"/);
  assert.doesNotMatch(rbac, /verbs: \[[^\]]*"(?:create|delete|patch|update)"/);
});

test("rejects terminal deployments without their required modules", () => {
  for (const disabled of ["modules.ui.enabled=false", "modules.execution.enabled=false", "modules.kubernetes.enabled=false"]) {
    const result = spawnSync(
      "helm",
      ["template", "mosaic", chart, "--namespace", "mosaic-test", "--set", "modules.terminal.enabled=true", "--set", disabled],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, disabled);
    assert.match(result.stderr, /modules\.terminal\.enabled=true requires/);
  }
});

test("omits the cluster monitor when its module is disabled", () => {
  const output = render();
  assert.doesNotMatch(output, /(?:name|app): mosaic-cluster-monitor(?:\s|$)/);
  assert.match(output, /name: MOSAIC_CLUSTERS_ENABLED\s+value: "false"/);
});

test("renders a credential-isolated persistent cluster monitor from configured targets", () => {
  const output = render(
    "--set", "modules.clusters.enabled=true",
    "--set", "modules.slurm.enabled=false",
    "--set", "bcmMcp.enabled=true",
    "--set", "kubernetes.clusters[0].name=training",
    "--set", "kubernetes.clusters[0].displayName=Training Kubernetes",
    "--set", "kubernetes.clusters[0].kubeconfigSecretRef.name=training-kubeconfig",
    "--set", "kubernetes.clusters[0].kubeconfigSecretRef.key=config",
  );
  const monitor = render(
    "--set", "modules.clusters.enabled=true",
    "--show-only", "templates/mosaic-cluster-monitor.yaml",
  );
  assert.match(output, /kind: Deployment[\s\S]*name: mosaic-cluster-monitor/);
  assert.match(output, /kind: Service[\s\S]*name: mosaic-cluster-monitor/);
  assert.match(output, /kind: PersistentVolumeClaim[\s\S]*name: mosaic-cluster-monitor/);
  assert.match(output, /kind: Secret[\s\S]*name: mosaic-cluster-monitor-auth/);
  assert.match(output, /command: \["node", "\/app\/frontend\/bin\/mosaic-cluster-monitor\.mjs"\]/);
  assert.match(output, /image: "nvcr\.io\/0948643769302270\/mosaic-ui:[0-9a-f]{8}"/);
  assert.match(output, /automountServiceAccountToken: false/);
  assert.match(output, /name: MOSAIC_CLUSTERS_ENABLED\s+value: "true"/);
  assert.match(output, /name: MOSAIC_CLUSTER_MONITOR_URL\s+value: "http:\/\/mosaic-cluster-monitor:3003"/);
  assert.match(output, /MOSAIC_CLUSTER_TARGETS[\s\S]*BCM Cluster/);
  assert.match(output, /MOSAIC_CLUSTER_TARGETS[\s\S]*Local Kubernetes/);
  assert.match(output, /MOSAIC_CLUSTER_TARGETS[\s\S]*Training Kubernetes/);
  assert.match(output, /name: MOSAIC_CLUSTER_TIMEOUT_MS\s+value: "600000"/);
  assert.doesNotMatch(monitor, /automountServiceAccountToken: true/);
});

test("validates cluster monitor dependencies and configuration", () => {
  const invalid = [
    ["modules.ui.enabled=false", /requires modules\.ui\.enabled=true/],
    ["modules.execution.enabled=false", /requires modules\.execution\.enabled=true/],
    ["mosaicClusterMonitor.auth.create=false", /cluster monitor auth requires/],
    ["mosaicClusterMonitor.historyLimit=0", /historyLimit must be at least 1/],
    ["mosaicClusterMonitor.timeoutMs=1000", /timeoutMs must be between 5000 and 600000/],
    ["mosaicClusterMonitor.defaultIntervalHours=0", /must be between 1 and 8760/],
    ["mosaicClusterMonitor.kubernetes.enabled=false", /requires at least one configured BCM or Kubernetes target/],
  ];
  for (const [setting, expected] of invalid) {
    const result = spawnSync(
      "helm",
      ["template", "mosaic", chart, "--namespace", "mosaic-test", "--set", "modules.clusters.enabled=true", "--set", setting],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, setting);
    assert.match(result.stderr, expected);
  }
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

test("creates the base workspace when every optional skill module is disabled", () => {
  const output = render(
    "--set", "modules.slurm.enabled=false",
    "--set", "modules.observability.enabled=false",
    "--set", "modules.bcm.enabled=false",
    "--show-only", "templates/openclaw.yaml",
  );
  assert.match(output, /mkdir -p \/home\/node\/\.openclaw\/tmp\/openclaw \/home\/node\/\.openclaw\/workspace\/skills/);
  assert.match(output, /cp \/seed\/AGENTS\.md \/home\/node\/\.openclaw\/workspace\/AGENTS\.md/);
});

test("initializes a fresh OpenClaw workspace before seeding it", () => {
  const output = render("--show-only", "templates/openclaw.yaml");
  assert.match(
    output,
    /mkdir -p \/home\/node\/\.openclaw\/tmp\/openclaw \/home\/node\/\.openclaw\/workspace[\s\S]*cp \/seed\/AGENTS\.md \/home\/node\/\.openclaw\/workspace\/AGENTS\.md/,
  );
});

test("preserves the Slurm evidence apiVersion after its SPDX header", () => {
  const output = render(
    "--show-only",
    "templates/slurm-evidence.yaml",
    "--set",
    "modules.slurm.enabled=true",
    "--set",
    "modules.bcm.enabled=false",
  );
  assert.match(output, /# SPDX-License-Identifier: Apache-2\.0\napiVersion: v1/);
  assert.doesNotMatch(output, /Apache-2\.0apiVersion/);
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
