// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { kubectlTarget } from "../files/openclaw-seed/extensions/kubernetes/runner.ts";
import { validateKubectlAdminRequest, validateKubectlReadRequest, formatKubectlApproval } from "../files/openclaw-seed/extensions/kubernetes/policy.ts";

const directory = mkdtempSync(path.join(tmpdir(), "kubectl-target-"));
const client = path.join(directory, "kubectl");
const ssh = path.join(directory, "ssh");
writeFileSync(client, `#!${process.execPath}
let input="";process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>console.log(JSON.stringify({args:process.argv.slice(2),input})));`, { mode: 0o755 });
writeFileSync(ssh, `#!${process.execPath}
const {spawnSync}=require("node:child_process");let input="";process.stdin.on("data",x=>input+=x);process.stdin.on("end",()=>{const r=spawnSync("/bin/sh",["-c",process.argv.at(-1)],{input,encoding:"utf8"});process.stdout.write(r.stdout);process.stderr.write(r.stderr);process.exit(r.status);});`, { mode: 0o755 });
const originalPath = process.env.PATH;
process.env.PATH = directory + path.delimiter + originalPath;
test.after(() => { process.env.PATH = originalPath; rmSync(directory, { recursive: true, force: true }); });
const settings = {
  command: client, defaultCluster: "registered", clusters: { registered: "/gateway/config" },
  timeoutMs: 2000, maxOutputBytes: 8192,
  remoteSsh: { command: ssh, hosts: [{ alias: "management", address: "192.0.2.7", user: "operator" }] },
};

test("registered gateway targets retain their own connection", async () => {
  const target = await kubectlTarget(settings, {}, validateKubectlReadRequest(["get", "namespaces"]));
  const execution = await target.execute();
  assert.equal(target.name, "registered");
  assert.equal(execution.code, 0);
  assert.deepEqual(JSON.parse(execution.stdout).args, ["--kubeconfig", "<kubeconfig>", "get", "namespaces"]);
});

test("configured host execution uses exact remote inputs and forwards standard input", async () => {
  for (const config of ["/remote/first config", "/different/second'config"]) {
    const args = ["--kubeconfig", config, "apply", "-f", "-"];
    const request = validateKubectlAdminRequest(args, "manifest\ncontents\n");
    const target = await kubectlTarget(settings, { host: "management" }, request);
    assert.ok(formatKubectlApproval(request, target.name).description.includes("operator@192.0.2.7"));
    const result = await target.execute();
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { args, input: request.stdin });
  }
});

test("remote targets require admin access and a configured unambiguous destination", async () => {
  const admin = validateKubectlAdminRequest(["version", "--client"], undefined);
  await assert.rejects(kubectlTarget(settings, { host: "missing" }, admin), /not configured/);
  await assert.rejects(kubectlTarget(settings, { host: "management", cluster: "registered" }, admin), /either/);
  await assert.rejects(kubectlTarget({ ...settings, remoteSsh: undefined }, { host: "management" }, admin), /configured SSH/);
  await assert.rejects(kubectlTarget(settings, { host: "management" }, validateKubectlReadRequest(["get", "namespaces"])), /admin tool/);
});
