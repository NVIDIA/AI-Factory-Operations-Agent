// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function findProcessors() {
  const projects = join(homedir(), ".openclaw/npm/projects");
  const candidates = readdirSync(projects).map(name => join(
    projects, name, "node_modules/@tencent-weixin/openclaw-weixin",
  )).filter(path => existsSync(join(path, "package.json")));
  if (candidates.length !== 1) throw new Error("Expected one installed Weixin plugin package");
  const root = candidates[0];
  if (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version !== "2.4.10") {
    throw new Error("The Weixin owner adapter requires plugin 2.4.10");
  }
  // Qualify both possible entry graphs, including the TypeScript fallback.
  return ["dist/src/messaging/process-message.js", "src/messaging/process-message.ts"]
    .map(path => join(root, path));
}

// The external plugin runs slash commands before its usual sender check, and
// legacy accounts without an owner may admit every sender. Check the QR owner's
// identity before commands, media downloads, and agent dispatch instead.
const marker = "// MOSAIC: personal WeChat is restricted to the saved QR owner.";
const paths = process.argv[2] ? [process.argv[2]] : findProcessors();
const updates = paths.map(path => {
  const source = readFileSync(path, "utf8");
  const match = source.match(/^([ \t]+)const receivedAt = Date\.now\(\);$/m);
  const indent = match?.[1] ?? "    ";
  const anchor = `${indent}const receivedAt = Date.now();`;
  const guard = `${indent}${marker}
${indent}const mosaicOwner = loadWeixinAccount(deps.accountId)?.userId?.trim();
${indent}if (!mosaicOwner || full.from_user_id !== mosaicOwner) {
${indent}    logger.warn("MOSAIC Weixin: refusing a sender without a matching saved QR owner");
${indent}    return;
${indent}}
`;
  if (source.includes(guard + anchor)) return [path, source];
  if (source.includes(marker)
      || !source.includes('import { loadWeixinAccount } from "../auth/accounts.js";')
      || !source.includes("export async function processOneMessage(")
      || !match || source.split(anchor).length !== 2) {
    throw new Error("Weixin owner-only patch target changed; review the pinned plugin before starting it");
  }
  return [path, source.replace(anchor, guard + anchor)];
});
for (const [path, source] of updates) {
  writeFileSync(path, source);
}
