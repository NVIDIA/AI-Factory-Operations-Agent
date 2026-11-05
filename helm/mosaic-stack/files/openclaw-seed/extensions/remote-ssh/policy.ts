// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type RemoteHost = {
  alias: string;
  address: string;
  user: string;
  port: number;
};

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
const ADDRESS = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const USER = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const FORBIDDEN_PROGRAMS = new Set(["ssh", "scp", "sftp"]);
const MAX_ARGS = 64;
const MAX_ARG_BYTES = 1024;
const MAX_COMMAND_BYTES = 8192;

function text(value: unknown, name: string) {
  if (typeof value !== "string" || !value) throw new Error(name + " must be a non-empty string");
  return value;
}

export function normalizeHosts(raw: unknown): RemoteHost[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("at least one remote SSH host is required");
  const aliases = new Set<string>();
  return raw.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`remote SSH host ${index} must be an object`);
    }
    const host = value as Record<string, unknown>;
    const alias = text(host.alias, `remote SSH host ${index} alias`);
    const address = text(host.address, `remote SSH host ${index} address`);
    const user = text(host.user, `remote SSH host ${index} user`);
    const port = host.port === undefined ? 22 : Number(host.port);
    if (!ALIAS.test(alias)) throw new Error(`remote SSH alias "${alias}" is invalid`);
    if (!ADDRESS.test(address)) throw new Error(`remote SSH address for "${alias}" is invalid`);
    if (!USER.test(user)) throw new Error(`remote SSH user for "${alias}" is invalid`);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`remote SSH port for "${alias}" must be between 1 and 65535`);
    }
    if (aliases.has(alias)) throw new Error(`remote SSH alias "${alias}" is duplicated`);
    aliases.add(alias);
    return { alias, address, user, port };
  });
}

export function quoteRemoteArg(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function classifySshRequest(raw: unknown, hosts: RemoteHost[]) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("remote SSH parameters must be an object");
  const params = raw as Record<string, unknown>;
  const extra = Object.keys(params).filter((key) => !["host", "argv"].includes(key));
  if (extra.length) throw new Error("unsupported remote SSH parameters: " + extra.join(", "));
  const alias = text(params.host, "host");
  const host = hosts.find((candidate) => candidate.alias === alias);
  if (!host) throw new Error(`remote SSH host "${alias}" is not configured`);
  if (!Array.isArray(params.argv) || params.argv.length === 0 || params.argv.length > MAX_ARGS) {
    throw new Error(`argv must contain between 1 and ${MAX_ARGS} arguments`);
  }
  const argv = params.argv.map((value, index) => {
    const argument = text(value, `argv[${index}]`);
    const bytes = Buffer.byteLength(argument);
    if (bytes > MAX_ARG_BYTES) throw new Error(`argv[${index}] exceeds ${MAX_ARG_BYTES} bytes`);
    if (/[\0\r\n]/.test(argument)) throw new Error(`argv[${index}] contains a forbidden control character`);
    return argument;
  });
  if (argv[0].startsWith("-")) throw new Error("the remote program cannot begin with '-'");
  const program = argv[0].split("/").at(-1)?.toLowerCase() || "";
  if (FORBIDDEN_PROGRAMS.has(program)) throw new Error("nested SSH clients are not allowed");
  if (argv.reduce((total, value) => total + Buffer.byteLength(value) + 1, 0) > MAX_COMMAND_BYTES) {
    throw new Error(`remote command exceeds ${MAX_COMMAND_BYTES} bytes`);
  }
  return {
    host,
    argv,
    remoteCommand: argv.map(quoteRemoteArg).join(" "),
  };
}
