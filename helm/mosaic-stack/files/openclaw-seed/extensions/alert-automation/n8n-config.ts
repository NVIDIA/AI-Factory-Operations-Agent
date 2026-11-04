// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type N8nConfig = {
  baseUrl: string;
  senderId: string;
  recipientId: string;
  tokenEnv: string;
  pollSeconds: number;
  maxPages: number;
};

export function normalizeN8n(raw: unknown, env: NodeJS.ProcessEnv): N8nConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("delivery.n8n must be an object");
  const value = raw as Record<string, unknown>;
  const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  for (const name of ["senderId", "recipientId"])
    if (typeof value[name] !== "string" || !guid.test(value[name] as string))
      throw new Error(`delivery.n8n.${name} must be an Entra user GUID`);
  const senderId = (value.senderId as string).toLowerCase();
  const recipientId = (value.recipientId as string).toLowerCase();
  if (senderId === recipientId)
    throw new Error("n8n needs distinct assistant and recipient identities");
  if (typeof value.baseUrl !== "string")
    throw new Error("n8n baseUrl is required");
  const endpoint = new URL(value.baseUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    endpoint.hostname,
  );
  if (
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && loopback)) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error(
      "n8n baseUrl requires HTTPS without credentials or query parameters",
    );
  const tokenEnv = value.tokenEnv ?? "MOSAIC_N8N_BRIDGE_TOKEN";
  if (
    typeof tokenEnv !== "string" ||
    !/^[A-Z][A-Z0-9_]*$/.test(tokenEnv) ||
    !env[tokenEnv] ||
    env[tokenEnv]!.length < 24
  )
    throw new Error(
      "n8n requires a dedicated bearer token of at least 24 characters",
    );
  const pollSeconds = value.pollSeconds ?? 30;
  const maxPages = value.maxPages ?? 20;
  if (
    !Number.isInteger(pollSeconds) ||
    Number(pollSeconds) < 1 ||
    Number(pollSeconds) > 3600
  )
    throw new Error("Invalid n8n pollSeconds");
  if (
    !Number.isInteger(maxPages) ||
    Number(maxPages) < 1 ||
    Number(maxPages) > 100
  )
    throw new Error("Invalid n8n maxPages");
  return {
    baseUrl: endpoint.href.replace(/\/+$/, ""),
    senderId,
    recipientId,
    tokenEnv,
    pollSeconds: Number(pollSeconds),
    maxPages: Number(maxPages),
  };
}
