// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifySshRequest, normalizeHosts, quoteRemoteArg } from "../files/openclaw-seed/extensions/remote-ssh/policy.ts";
import { buildSshArgs, redactSshOutput } from "../files/openclaw-seed/extensions/remote-ssh/runner.ts";

const hosts = normalizeHosts([{ alias: "worker-1", address: "10.0.0.7", user: "root", port: 2222 }]);

test("resolves configured hosts and preserves exact argv through POSIX quoting", () => {
  const request = classifySshRequest({ host: "worker-1", argv: ["printf", "%s", "a b", "it's"] }, hosts);
  assert.equal(request.host.address, "10.0.0.7");
  assert.equal(request.remoteCommand, "'printf' '%s' 'a b' 'it'\"'\"'s'");
  assert.equal(quoteRemoteArg("$(id); rm -rf /"), "'$(id); rm -rf /'");
});

test("rejects unknown hosts and all connection override fields", () => {
  assert.throws(
    () => classifySshRequest({ host: "missing", argv: ["true"] }, hosts),
    /not configured/,
  );
  for (const field of ["sshArgs", "identityFile", "destination", "proxyCommand", "config"]) {
    assert.throws(
      () => classifySshRequest({ host: "worker-1", argv: ["true"], [field]: "override" }, hosts),
      /unsupported remote SSH parameters/,
    );
  }
});

test("rejects malformed argv and nested SSH clients", () => {
  for (const argv of [[], ["-V"], ["ssh", "elsewhere"], ["scp", "a", "b"], ["echo", "bad\nline"]]) {
    assert.throws(() => classifySshRequest({ host: "worker-1", argv }, hosts));
  }
  assert.throws(
    () => classifySshRequest({ host: "worker-1", argv: ["x".repeat(1025)] }, hosts),
    /exceeds 1024 bytes/,
  );
});

test("builds only fixed hardened SSH connection options", () => {
  const settings = {
    command: "/tools/ssh",
    keyPath: "/var/run/mosaic-ssh/id",
    knownHostsPath: "/var/run/mosaic-ssh/known_hosts",
    timeoutMs: 60_000,
    maxOutputBytes: 65_536,
  };
  const args = buildSshArgs(settings, hosts[0], "'touch' '/tmp/marker'");
  assert.deepEqual(args.slice(-3), ["--", "root@10.0.0.7", "'touch' '/tmp/marker'"]);
  for (const option of [
    "BatchMode=yes",
    "PreferredAuthentications=publickey",
    "StrictHostKeyChecking=yes",
    "ProxyCommand=none",
    "ProxyJump=none",
    "ClearAllForwardings=yes",
    "ServerAliveCountMax=2",
  ]) assert.ok(args.includes(option), option);
  assert.ok(args.some((value) => value.startsWith("ServerAliveInterval=")));
  assert.equal(args.filter((value) => value === "-i").length, 1);
});

test("redacts all credential paths from process output", () => {
  const settings = {
    keyPath: "/var/run/mosaic-ssh/id",
    knownHostsPath: "/var/run/mosaic-ssh/known_hosts",
  };
  const output = redactSshOutput(
    "identity /var/run/mosaic-ssh/id known /var/run/mosaic-ssh/known_hosts",
    settings,
  );
  assert.doesNotMatch(output, /\/var\/run\/mosaic-ssh/);
  assert.match(output, /<ssh-private-key>/);
  assert.match(output, /<ssh-known-hosts>/);
});

test("blocks remote SSH in readonly automation sessions", () => {
  const source = readFileSync(
    new URL("../files/openclaw-seed/extensions/remote-ssh/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /isReadonlyAutomationSession\(context\.sessionKey\)/);
});
