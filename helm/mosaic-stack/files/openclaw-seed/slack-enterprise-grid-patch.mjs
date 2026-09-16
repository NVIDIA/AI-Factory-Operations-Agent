// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function findProvider() {
  const projects = join(homedir(), ".openclaw/npm/projects");
  const project = readdirSync(projects).find((name) => name.startsWith("openclaw-slack-"));
  if (!project) throw new Error("OpenClaw Slack plugin project not found");
  const dist = join(projects, project, "node_modules/@openclaw/slack/dist");
  const provider = readdirSync(dist).find((name) => name.startsWith("provider-") && name.endsWith(".js"));
  if (!provider) throw new Error("OpenClaw Slack provider not found");
  return join(dist, provider);
}

const path = process.argv[2] ?? findProvider();
const source = readFileSync(path, "utf8");
const teamLine = '\t\tconst incomingTeamId = typeof raw.team_id === "string" ? raw.team_id : typeof raw.team?.id === "string" ? raw.team.id : "";';
const teamCheck = '\t\tif (params.teamId && incomingTeamId && incomingTeamId !== params.teamId) {';
const enterpriseLine = '\t\tconst incomingEnterpriseId = typeof raw.enterprise_id === "string" ? raw.enterprise_id : "";';
const enterpriseCheck = '\t\tif (params.teamId && incomingTeamId && incomingTeamId !== params.teamId && incomingEnterpriseId !== params.teamId) {';
if (source.includes(enterpriseLine) && source.includes(enterpriseCheck)) process.exit(0);
if (!source.includes(teamLine) || !source.includes(teamCheck)) {
  throw new Error("OpenClaw Slack enterprise patch target changed");
}
const patched = source
  .replace(teamLine, `${teamLine}\n${enterpriseLine}`)
  .replace(teamCheck, enterpriseCheck);
writeFileSync(path, patched);
