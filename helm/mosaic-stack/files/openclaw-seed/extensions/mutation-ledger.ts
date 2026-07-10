// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

export type MutationState = "running" | "completed" | "failed";

type Record = {
  id: string;
  fingerprint: string;
  state: MutationState;
  startedAt: string;
  finishedAt?: string;
};

type Input = {
  toolCallId: string;
  toolName: string;
  target: string;
  args: unknown;
  ledgerPath?: string;
};

const active = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>) {
  const result = queue.then(operation, operation);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function filePath(input: Input) {
  return input.ledgerPath || process.env.MOSAIC_EDIT_LEDGER_PATH || "/home/node/.openclaw/mosaic-edit-ledger.json";
}

function fingerprint(input: Input) {
  return createHash("sha256")
    .update(JSON.stringify([input.toolName, input.target, input.args]))
    .digest("hex");
}

async function read(file: string) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(value) ? value as Record[] : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function write(file: string, records: Record[]) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(records.slice(-1000)), { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function runMutationOnce<T>(
  input: Input,
  operation: () => Promise<T>,
  state: (result: T) => Exclude<MutationState, "running"> = () => "completed",
) {
  if (!input.toolCallId.trim()) throw new Error("mutation requires a tool call id");
  const file = filePath(input);
  const key = `${file}:${input.toolCallId}`;
  const hash = fingerprint(input);
  const claim = await serialized(async () => {
    const records = await read(file);
    const existing = records.find(record => record.id === input.toolCallId);
    if (existing) {
      if (existing.fingerprint !== hash) throw new Error("tool call id was already used for a different mutation");
      if (existing.state === "running" && !active.has(key)) {
        existing.state = "failed";
        existing.finishedAt = new Date().toISOString();
        await write(file, records);
      }
      return { execute: false as const, state: existing.state };
    }
    records.push({ id: input.toolCallId, fingerprint: hash, state: "running", startedAt: new Date().toISOString() });
    active.add(key);
    await write(file, records);
    return { execute: true as const };
  });
  if (!claim.execute) return { replayed: true as const, state: claim.state };

  try {
    const result = await operation();
    const finalState = state(result);
    await serialized(async () => {
      const records = await read(file);
      const record = records.find(item => item.id === input.toolCallId && item.fingerprint === hash);
      if (record) {
        record.state = finalState;
        record.finishedAt = new Date().toISOString();
        await write(file, records);
      }
    });
    return { replayed: false as const, state: finalState, result };
  } catch (error) {
    await serialized(async () => {
      const records = await read(file);
      const record = records.find(item => item.id === input.toolCallId && item.fingerprint === hash);
      if (record) {
        record.state = "failed";
        record.finishedAt = new Date().toISOString();
        await write(file, records);
      }
    });
    throw error;
  } finally {
    active.delete(key);
  }
}
