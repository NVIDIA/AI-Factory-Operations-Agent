// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { Runtime } from "./core.ts";
import { sha256 } from "./core.ts";

/** Exact UTF-8 chunks: no trimmed whitespace, dropped characters or altered report facts. */
export function reportChunks(
  text: string,
  maxCharacters = 2000,
  maxBytes = 8000,
) {
  const chunks: string[] = [];
  let chunk = "",
    characters = 0,
    bytes = 0;
  for (const character of text) {
    const width = Buffer.byteLength(character);
    if (chunk && (characters + 1 > maxCharacters || bytes + width > maxBytes)) {
      chunks.push(chunk);
      chunk = "";
      characters = 0;
      bytes = 0;
    }
    chunk += character;
    characters++;
    bytes += width;
  }
  if (chunk) chunks.push(chunk);
  if (chunks.join("") !== text)
    throw new Error("Complete report chunk integrity failure");
  return chunks;
}

export function nativeRuntime(api: OpenClawPluginApi): Runtime {
  return {
    run: (params) =>
      api.runtime.subagent.run(
        params as Parameters<typeof api.runtime.subagent.run>[0],
      ),
    wait: (params) => api.runtime.subagent.waitForRun(params),
    history: async (params) =>
      (await api.runtime.subagent.getSessionMessages(params)) as {
        messages: Record<string, any>[];
      },
    async deliver(params, record) {
      const { delivery, report, signal } = params;
      const adapter = await api.runtime.channel.outbound.loadAdapter(
        delivery.channel,
      );
      if (!adapter?.sendText)
        throw new Error(
          "The selected native channel has no text outbound adapter",
        );
      // Conservative limits work across channel adapters; complete text is retained in order.
      const limit = Math.max(1, Math.min(2000, adapter.textChunkLimit ?? 2000));
      const chunks = reportChunks(report, limit);
      record("native-delivery.intent.json", {
        channel: delivery.channel,
        target: delivery.target,
        accountId: delivery.accountId,
        sessionKey: delivery.sessionKey,
        idempotencyKey: params.idempotencyKey,
        messageBytes: Buffer.byteLength(report),
        messageSha256: sha256(report),
        parts: chunks.map((text, index) => ({
          index,
          characters: [...text].length,
          bytes: Buffer.byteLength(text),
          sha256: sha256(text),
        })),
        contentTruncated: false,
        chunking:
          "lossless UTF-8; concatenation equals complete published report",
      });
      const messageIds: string[] = [];
      const results: unknown[] = [];
      for (let index = 0; index < chunks.length; index++) {
        signal.throwIfAborted();
        record(`native-delivery.part-${index + 1}.intent.json`, {
          index,
          sha256: sha256(chunks[index]),
          bytes: Buffer.byteLength(chunks[index]),
        });
        const result = await adapter.sendText({
          cfg: api.config,
          to: delivery.target,
          text: chunks[index],
          accountId: delivery.accountId,
        });
        record(`native-delivery.part-${index + 1}.receipt.json`, result);
        if (!result?.messageId)
          throw new Error(
            "Native channel returned no confirmed platform message ID",
          );
        messageIds.push(result.messageId);
        results.push(result);
        record("native-delivery.progress.json", {
          messageIds,
          completedParts: index + 1,
          totalParts: chunks.length,
        });
      }
      return {
        messageIds,
        results,
        channel: delivery.channel,
        sessionKey: delivery.sessionKey,
        completeReportSha256: sha256(report),
      };
    },
  };
}
