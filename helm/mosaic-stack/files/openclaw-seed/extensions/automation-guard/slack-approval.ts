// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";
import { recordApprovalDecision } from "../mutation-ledger.ts";
import type {
  ApprovalDecision,
  ApprovalRequest,
  RunAccess,
} from "../automation-context.ts";

type PendingApproval = {
  senderId: string;
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
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

export function installSlackApprovalBroker(api: any, editUserIds: string[], ledgerPath?: string) {
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
      await recordApprovalDecision({
        id: request.request.toolCallId ?? id,
        toolName: request.request.toolName ?? "unknown",
        senderId: ctx.senderId,
        decision,
        ledgerPath,
      });
      request.resolve(decision);
      const status = decision === "allow" ? "Approved" : "Denied";
      const execution = decision === "allow"
        ? "Authorized."
        : "Not executed.";
      const result = decision === "allow" ? "Reported separately by the tool." : "Not run.";
      await ctx.respond?.editMessage?.({
        text: `${request.request.title}\n${request.request.description}\nApproval: ${status} by <@${ctx.senderId}>.\nExecution: ${execution}\nResult: ${result}`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*${request.request.title}*\n${request.request.description}`,
            },
          },
          {
            type: "context",
            elements: [{
              type: "mrkdwn",
              text: `*Approval:* ${status} by <@${ctx.senderId}>.\n*Execution:* ${execution}\n*Result:* ${result}`,
            }],
          },
        ],
      });
      return { handled: true };
    },
  });

  return async (access: RunAccess, request: ApprovalRequest) => {
    if (!access.senderId || !editUsers.has(access.senderId)) return "deny" as const;
    const id = randomUUID();
    const timeoutMs = request.timeoutMs ?? 120_000;
    const decision = new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        void recordApprovalDecision({
          id: request.toolCallId ?? id,
          toolName: request.toolName ?? "unknown",
          senderId: access.senderId!,
          decision: "timeout",
          ledgerPath,
        }).catch(() => undefined);
        resolve("timeout");
      }, timeoutMs);
      pending.set(id, { senderId: access.senderId!, request, resolve, timer });
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
