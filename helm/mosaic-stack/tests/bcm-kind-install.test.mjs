// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const chart = fileURLToPath(new URL('../', import.meta.url));
const installer = join(chart, 'files/setup-bcm-kind.sh');
const run = (script, env = {}) => spawnSync('bash', ['-c', `source "$INSTALLER"\n${script}`], {
  encoding: 'utf8', env: {...process.env, INSTALLER: installer, ...env}, maxBuffer: 8 * 1024 * 1024,
});

test('Kind values use authenticated HTTPS, preserve literal inference inputs, and render without an SSH adapter', () => {
  for (const model of ['served-model', 'model,revision $(echo literal)']) {
    const result = run('write_values "$GATEWAY" "$LLM_URL" "$MODEL"', {
      GATEWAY: '172.20.0.1', LLM_URL: 'https://inference.example.test/v1', MODEL: model,
    });
    assert.equal(result.status, 0, result.stderr);
    const values = JSON.parse(result.stdout);
    assert.equal(values.llm.external.model, model);
    assert.equal(values.bcmMcp.mcpUrl, 'https://172.20.0.1:3002/mcp');
    assert.equal(values.bcmMcp.authTokenCreate, false);
    assert.equal(values.bcmMcp.hostSshKeySecretName, '');
    assert.equal(values.bcmMcp.caCertificateSecret, 'bcm-mcp-ca');
    assert.ok(values.modules.bcm.enabled && values.modules.kubernetes.enabled);
    assert.equal(values.modules.edit.enabled, false);
    const rendered = spawnSync('helm', ['template', 'aifoa', chart, '-f', '-'], {input: result.stdout, encoding: 'utf8'});
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.ok(!rendered.stdout.includes('name: bcm-host-ssh-key'));
    assert.ok(!rendered.stdout.includes('name: bcm-mcp\n'));
    assert.ok(!result.stdout.includes('apiKey') && !result.stdout.includes('authToken"'));
  }
});

test('service installation creates a trusted gateway certificate and byte-identical token configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'bcm-service-install-'));
  try {
    const result = run(`
      install() {
        local args=() arg
        for arg in "$@"; do
          case "$arg" in
            /var/lib/bcm-mcp/notes) arg="$CASE_ROOT/notes";;
            /etc/systemd/system/afoa-bcm-mcp.service) arg="$CASE_ROOT/unit.service";;
          esac
          args+=("$arg")
        done
        command install "\${args[@]}"
      }
      docker() {
        printf '%s\\n' "$*" >> "$CASE_ROOT/docker.log"
        case "$1" in
          run) printf '%s\\n' "$PACKAGE_VERSION";;
          create) printf 'test-container\\n';;
          cp) mkdir -p "$3/$(basename "$2")";;
        esac
      }
      uv() { :; }
      systemctl() { printf '%s\\n' "$*" >> "$CASE_ROOT/systemctl.log"; }
      install_service "$CHART" "$CASE_ROOT/service" "$CASE_ROOT/config" "$GATEWAY" example.test/bcm:pinned
    `, {CASE_ROOT: root, CHART: chart, GATEWAY: '192.0.2.42', PACKAGE_VERSION: '7.4.2'});
    assert.equal(result.status, 0, result.stderr);
    const token = readFileSync(join(root, 'config/token'), 'utf8');
    const env = Object.fromEntries(readFileSync(join(root, 'config/server.env'), 'utf8').trim().split('\n').map(line => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
    assert.ok(token.length >= 32);
    assert.equal(token, token.trim());
    assert.equal(env.MOSAIC_BCM_MCP_TOKEN, token);
    assert.equal(env.MOSAIC_BCM_EXECUTION_MODE, 'local');
    assert.equal(env.MOSAIC_BCM_PUBLIC_URL, 'https://192.0.2.42:3002');
    assert.equal(env.MOSAIC_BCM_CMSH_ENABLED, 'true');
    assert.equal(env.MOSAIC_BCM_CMSH_ADMIN_ENABLED, 'false');
    assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
    assert.ok(readFileSync(join(root, 'docker.log'), 'utf8').includes('bcm_mcp_tools-7.4.2.dist-info'));
    assert.ok(!readFileSync(join(root, 'systemctl.log'), 'utf8').includes('restart'));
    const cert = join(root, 'config/server.crt');
    const verified = spawnSync('openssl', ['verify', '-CAfile', cert, '-verify_ip', '192.0.2.42', cert], {encoding: 'utf8'});
    assert.equal(verified.status, 0, verified.stderr);
    const mismatch = spawnSync('openssl', ['verify', '-CAfile', cert, '-verify_ip', '192.0.2.43', cert]);
    assert.notEqual(mismatch.status, 0);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

for (const [label, uid, port, cluster, message] of [
  ['non-root caller', '1000', '', '', 'Run this installer as root'],
  ['occupied port', '0', 'LISTEN', '', 'TCP port 3002 is already in use'],
  ['existing cluster', '0', '', 'mosaic', 'Kind cluster mosaic already exists'],
]) test(`preflight rejects ${label} before creating or modifying anything`, () => {
  const result = run(`
    id() { printf '%s\\n' "$CALLER_UID"; }
    ss() { printf '%s' "$OCCUPIED_PORT"; }
    docker() { [[ $1 == info ]] || { echo 'unexpected mutation'; exit 90; }; }
    kind() { [[ $1 == get ]] || { echo 'unexpected mutation'; exit 90; }; printf '%s' "$EXISTING_CLUSTER"; }
    cmsh() { :; }
    helm() { echo 'unexpected mutation'; exit 90; }
    kubectl() { echo 'unexpected mutation'; exit 90; }
    systemctl() { echo 'unexpected mutation'; exit 90; }
    main
  `, {CALLER_UID: uid, OCCUPIED_PORT: port, EXISTING_CLUSTER: cluster});
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(message), result.stderr);
  assert.ok(!result.stdout.includes('unexpected mutation'));
});

test('Kind gateway selection uses IPv4 regardless of Docker IPAM order', () => {
  for (const ipv4 of ['172.23.0.1', '192.0.2.17']) {
    const entries = [{Gateway: 'fd42:abcd::1'}, {Gateway: ipv4}, {Subnet: '10.0.0.0/24'}];
    for (const ipam of [entries, [...entries].reverse()]) {
      const result = run('docker() { printf "%s" "$IPAM"; }; kind_gateway', {IPAM: JSON.stringify(ipam)});
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), ipv4);
    }
  }
  const result = run('docker() { printf "%s" "$IPAM"; }; kind_gateway', {IPAM: JSON.stringify([{Gateway: 'fd42:abcd::1'}])});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});
