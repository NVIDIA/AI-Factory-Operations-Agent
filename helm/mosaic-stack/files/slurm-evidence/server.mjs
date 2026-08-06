// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const hostRoot = process.env.HOST_ROOT || '/host';
const roots = (process.env.EVIDENCE_ROOTS || '').split(':').filter(Boolean);
const authToken = process.env.EVIDENCE_AUTH_TOKEN || '';
const maxFileBytes = Number(process.env.MAX_FILE_BYTES || 65536);
const maxMatches = Number(process.env.MAX_MATCHES || 40);
const maxVisitedFiles = Number(process.env.MAX_VISITED_FILES || 50000);

if (!authToken) throw new Error('EVIDENCE_AUTH_TOKEN is required');

function uncheckedHostPath(rawPath) {
  const clean = path.resolve('/', rawPath || '/');
  if (!roots.some(root => clean === root || clean.startsWith(`${root.replace(/\/$/, '')}/`))) {
    throw new Error(`path is outside allowed roots: ${rawPath}`);
  }
  return path.join(hostRoot, clean.slice(1));
}

const canonicalRoots = await Promise.all(roots.map(async root => realpath(uncheckedHostPath(root)).catch(() => undefined)));

async function hostPath(rawPath) {
  const target = await realpath(uncheckedHostPath(rawPath));
  if (!canonicalRoots.some(root => root && (target === root || target.startsWith(`${root}${path.sep}`)))) {
    throw new Error(`path is outside allowed roots: ${rawPath}`);
  }
  return target;
}

function publicPath(fullPath) {
  const relative = path.relative(hostRoot, fullPath);
  return relative.startsWith('..') ? fullPath : `/${relative}`;
}

async function* walk(root, counter) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!['.git', 'node_modules', '.cache'].includes(entry.name)) yield* walk(full, counter);
    } else if (entry.isFile()) {
      counter.visited += 1;
      if (counter.visited > maxVisitedFiles) return;
      yield full;
    }
  }
}

async function readTail(fullPath, limit = maxFileBytes) {
  const data = await readFile(fullPath);
  const truncated = data.length > limit;
  return { text: data.subarray(Math.max(0, data.length - limit)).toString('utf8'), truncated };
}

async function findJobFiles(jobId) {
  const patterns = [`slurm-${jobId}.out`, `-${jobId}.out`, `_${jobId}_`, `.${jobId}.`];
  const matches = [];
  const counter = { visited: 0 };
  for (const root of roots) {
    const bases = root === '/cm/shared'
      ? await Promise.all(['/cm/shared/training', '/cm/shared/slurm-logs', '/cm/shared'].map(candidate => hostPath(candidate).catch(() => undefined)))
      : [await hostPath(root).catch(() => undefined)];
    for (const base of bases) {
      if (!base) continue;
      for await (const file of walk(base, counter)) {
        const name = path.basename(file);
        if (patterns.some(pattern => name.includes(pattern))) {
          const info = await stat(file).catch(() => null);
          matches.push({ path: publicPath(file), bytes: info?.size || 0 });
          if (matches.length >= maxMatches) return matches;
        }
        if (counter.visited > maxVisitedFiles) return matches;
      }
    }
  }
  return matches;
}

async function grepFiles(pattern, root = '/', pathFilter = () => true) {
  const regex = new RegExp(pattern, 'i');
  const matches = [];
  const counter = { visited: 0 };
  const bases = root === '/'
    ? await Promise.all(roots.map(candidate => hostPath(candidate).catch(() => undefined)))
    : [await hostPath(root)];
  for (const base of bases) {
    if (!base) continue;
    for await (const file of walk(base, counter)) {
      if (!pathFilter(publicPath(file))) continue;
      let text;
      try {
        text = (await readTail(file, Math.min(maxFileBytes, 16384))).text;
      } catch {
        continue;
      }
      const lines = text.split('\n').filter(line => regex.test(line)).slice(0, 5);
      if (lines.length) matches.push({ path: publicPath(file), lines });
      if (matches.length >= maxMatches || counter.visited > maxVisitedFiles) return matches;
    }
  }
  return matches;
}

function isSlurmPath(filePath) {
  return /(^|\/)slurm([^/]*|\/)/i.test(filePath);
}

function jobIdPattern(jobId) {
  return `(^|[^0-9])${jobId}([^0-9]|$)`;
}

async function slurmJobEvidence(jobId) {
  const files = await findJobFiles(jobId);
  const snippets = [];
  for (const item of files.slice(0, 10)) {
    try {
      const { text, truncated } = await readTail(await hostPath(item.path));
      const lines = text.split('\n');
      snippets.push({
        path: item.path,
        truncated,
        interesting_lines: lines.filter(line => /error|exception|traceback|failed|exit|not found|missing|timeout|nccl|cuda|fabric|bootstrap|warn/i.test(line)).slice(0, 40),
        tail: lines.slice(-80),
      });
    } catch (error) {
      snippets.push({ path: item.path, error: String(error?.message || error) });
    }
  }
  return {
    job_id: jobId,
    searched_roots: roots,
    matched_files: files,
    snippets,
    slurm_logs: await grepFiles(jobIdPattern(jobId), '/var/log', isSlurmPath),
    slurm_config: await grepFiles('SlurmctldLogFile|SlurmdLogFile|AccountingStorage|StateSaveLocation', '/etc/slurm'),
  };
}

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function authorized(req) {
  const header = String(req.headers.authorization || '');
  if (!header.startsWith('Bearer ')) return false;
  const supplied = header.slice(7);
  const expected = Buffer.from(authToken);
  const actual = Buffer.from(supplied);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createEvidenceServer() {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      if (url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/slurm/job') {
        const id = url.searchParams.get('id') || '';
        if (!/^[0-9]+(?:_[0-9]+)?$/.test(id)) throw new Error('id must be a Slurm job id');
        return send(res, 200, await slurmJobEvidence(id));
      }
      if (url.pathname === '/read') {
        const target = url.searchParams.get('path') || '';
        return send(res, 200, { path: target, ...(await readTail(await hostPath(target))) });
      }
      if (url.pathname === '/grep') {
        const pattern = url.searchParams.get('pattern') || '';
        if (!pattern) throw new Error('pattern is required');
        const root = url.searchParams.get('root') || '/';
        return send(res, 200, { root, pattern, matches: await grepFiles(pattern, root) });
      }
      send(res, 404, { error: 'not found' });
    } catch (error) {
      send(res, 400, { error: String(error?.message || error) });
    }
  });
}

if (process.env.EVIDENCE_TEST_MODE !== '1') {
  createEvidenceServer().listen(Number(process.env.PORT || 8080), '0.0.0.0');
}
