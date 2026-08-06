// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("authenticates evidence reads and rejects symlink escapes", async () => {
  const host = await mkdtemp(path.join(tmpdir(), "slurm-evidence-"));
  const logRoot = path.join(host, "var/log");
  await mkdir(logRoot, { recursive: true });
  await writeFile(path.join(logRoot, "slurm.log"), "safe evidence\n");
  await writeFile(path.join(host, "secret"), "host secret\n");
  await symlink("../../secret", path.join(logRoot, "escaped"));
  process.env.HOST_ROOT = host;
  process.env.EVIDENCE_ROOTS = "/var/log";
  process.env.EVIDENCE_AUTH_TOKEN = "test-token";
  process.env.EVIDENCE_TEST_MODE = "1";
  const { createEvidenceServer } = await import(`../files/slurm-evidence/server.mjs?${Date.now()}`);
  const server = createEvidenceServer().listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const { port } = server.address();
  const request = (pathname, token) => fetch(`http://127.0.0.1:${port}${pathname}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  try {
    assert.equal((await request("/healthz")).status, 200);
    assert.equal((await request("/read?path=/var/log/slurm.log")).status, 401);
    assert.equal((await request("/read?path=/var/log/slurm.log", "wrong")).status, 401);
    const allowed = await request("/read?path=/var/log/slurm.log", "test-token");
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).text, "safe evidence\n");
    assert.equal((await request("/read?path=/var/log/escaped", "test-token")).status, 400);
  } finally {
    server.close();
    await rm(host, { recursive: true, force: true });
  }
});
