// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(directory, binding, capacity = 10000) {
    fs.mkdirSync(directory, {recursive:true, mode:0o700});
    this.capacity = capacity;
    this.db = new DatabaseSync(path.join(directory, 'bridge.sqlite'));
    try {
      // One writer process for this volume. The exclusive lock is held until
      // close, including between transactions, and released by OS on a crash.
      this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE; COMMIT;');
      this.db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, state TEXT NOT NULL, message_key TEXT UNIQUE, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS jobs_channel_ack ON jobs (
          json_extract(data,'$.channel'), json_extract(data,'$.root'), json_extract(data,'$.user')
        ) WHERE json_extract(data,'$.kind')='channel_ack';`);
      const existing = this.db.prepare('SELECT value FROM meta WHERE key=?').get('binding');
      const value = JSON.stringify(binding);
      if (existing && existing.value !== value) throw new Error('state_binding_mismatch');
      this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('binding', value);
      fs.chmodSync(path.join(directory, 'bridge.sqlite'), 0o600);
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(id) { const row = this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id); return row ? JSON.parse(row.data) : undefined; }
  jobs() { return this.db.prepare("SELECT data FROM jobs WHERE state NOT IN ('done','failed','send_unknown','rejected') ORDER BY rowid").all().map(row => JSON.parse(row.data)); }
  pending() {
    return this.db.prepare(`SELECT id, json_extract(data,'$.user') AS user,
      json_extract(data,'$.nextAt') AS nextAt FROM jobs
      WHERE state NOT IN ('done','failed','send_unknown','rejected') ORDER BY rowid`).all();
  }
  hasMessage(id) { return Boolean(this.db.prepare('SELECT id FROM jobs WHERE message_key=?').get(id)); }
  channelAckId(channel, root, user) {
    return this.db.prepare(`SELECT id FROM jobs WHERE json_extract(data,'$.kind')='channel_ack'
      AND json_extract(data,'$.channel')=? AND json_extract(data,'$.root')=? AND json_extract(data,'$.user')=?
      ORDER BY rowid DESC LIMIT 1`).get(channel,root,user)?.id;
  }
  counts() { return Object.fromEntries(this.db.prepare('SELECT state,count(*) AS n FROM jobs GROUP BY state').all().map(row => [row.state,row.n])); }
  save(row) { this.db.prepare('UPDATE jobs SET state=?,data=? WHERE id=?').run(row.state,JSON.stringify(row), row.id); }
  add(row) {
    if (this.get(row.id)) return false;
    if (this.db.prepare('SELECT count(*) AS n FROM jobs').get().n >= this.capacity) throw new Error('state_capacity');
    this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?)').run(row.id,row.state,row.messageKey ?? null,JSON.stringify(row)); return true;
  }
  thread(id) { const row = this.db.prepare('SELECT data FROM threads WHERE id=?').get(id); return row ? JSON.parse(row.data) : undefined; }
  bind(thread) {
    const old = this.thread(thread.id);
    if (old && JSON.stringify(old) !== JSON.stringify(thread)) throw new Error('thread_binding_conflict');
    this.db.prepare('INSERT OR IGNORE INTO threads VALUES (?,?)').run(thread.id, JSON.stringify(thread));
  }
  close() { this.db.close(); }
}
