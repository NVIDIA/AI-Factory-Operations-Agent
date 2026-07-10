// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import type {
  MosaicApprovalDecision,
  MosaicApprovalRequest,
  MosaicRunAccess,
} from "../automation-context.ts";

type PendingApproval = {
  senderId: string;
  resolve: (decision: MosaicApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
};

type SlackInteraction = {
  senderId?: string;
  interaction?: { payload?: string };
  respond?: {
    reply?: (params: { text: string; responseType?: "ephemeral" | "in_channel" }) => Promise<void>;
    editMessage?: (params: { text?: string; blocks?: unknown[] }) => Promise<void>;
  };
};

export function installSlackApprovalBroker(api: any, editUserIds: string[]) {
  const editUsers = new Set(editUserIds);
  const pending = new Map<string, PendingApproval>();

  api.registerInteractiveHandler({
    channel: "slack",
    namespace: "mosaic-approval",
    async handler(ctx: SlackInteraction) {
      const [decision, id] = ctx.interaction?.payload?.split(":") ?? [];
      const request = pending.get(id);
      if (!request || (decision !== "allow" && decision !== "deny")) return { handled: false };
      if (!ctx.senderId || !editUsers.has(ctx.senderId) || ctx.senderId !== request.senderId) {
        await ctx.respond?.reply?.({ text: "You are not authorized to decide this request." });
        return { handled: true };
      }
      clearTimeout(request.timer);
      pending.delete(id);
      request.resolve(decision);
      await ctx.respond?.editMessage?.({
        text: decision === "allow" ? "Action approved." : "Action denied.",
        blocks: [],
      });
      return { handled: true };
    },
  });

  return async (access: MosaicRunAccess, request: MosaicApprovalRequest) => {
    if (!access.senderId || !editUsers.has(access.senderId)) return "deny" as const;
    const id = randomUUID();
    const timeoutMs = request.timeoutMs ?? 120_000;
    const decision = new Promise<MosaicApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve("timeout");
      }, timeoutMs);
      pending.set(id, { senderId: access.senderId!, resolve, timer });
    });
    const outbound = await api.runtime.channel.outbound.loadAdapter("slack");
    if (!outbound?.sendPayload) {
      clearTimeout(pending.get(id)?.timer);
      pending.delete(id);
      return "deny" as const;
    }
    try {
      await outbound.sendPayload({
        cfg: api.config,
        to: `user:${access.senderId}`,
        text: request.title,
        payload: {
          text: `${request.title}\n${request.description}`,
          channelData: {
            slack: {
              blocks: [
                {
                  type: "section",
                  text: { type: "mrkdwn", text: `*${request.title}*\n${request.description}` },
                },
                {
                  type: "actions",
                  block_id: `mosaic_approval_${id}`,
                  elements: [
                    {
                      type: "button",
                      action_id: "mosaic-approval:allow",
                      text: { type: "plain_text", text: "Approve" },
                      value: id,
                      style: "primary",
                    },
                    {
                      type: "button",
                      action_id: "mosaic-approval:deny",
                      text: { type: "plain_text", text: "Deny" },
                      value: id,
                      style: "danger",
                    },
                  ],
                },
              ],
            },
          },
        },
      });
    } catch {
      clearTimeout(pending.get(id)?.timer);
      pending.delete(id);
      return "deny" as const;
    }
    return decision;
  };
}
