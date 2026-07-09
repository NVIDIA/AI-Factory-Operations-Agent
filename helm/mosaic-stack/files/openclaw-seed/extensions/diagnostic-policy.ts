// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const PROGRAM = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ARGUMENT = /^[A-Za-z0-9_./:=,+%@-]+$/;
const SHELL_SYNTAX = /[\0\r\n;&|`$<>()[\]{}*?!\\'\"]/;

const exact = (...commands: string[][]) => (args: string[]) =>
  commands.some(command => command.length === args.length && command.every((value, index) => value === args[index]));

const flags = (allowed: RegExp) => (args: string[]) => args.every(argument => allowed.test(argument));

function nvidiaSmi(args: string[]) {
  let needsId = false;
  for (const argument of args) {
    if (needsId) {
      if (!/^[A-Za-z0-9_.:-]+$/.test(argument)) return false;
      needsId = false;
    } else if (argument === '-i' || argument === '--id') {
      needsId = true;
    } else if (![
      '-L', '--list-gpus', '-q', '--display=COMPUTE', '--display=MEMORY', '--display=POWER',
      '--display=TEMPERATURE', '--display=UTILIZATION', '--format=csv', '--format=csv,noheader',
      '--format=csv,nounits', '--format=csv,noheader,nounits',
    ].includes(argument) && !/^--query-(gpu|compute-apps)=[A-Za-z0-9_.,-]+$/.test(argument)) return false;
  }
  return !needsId;
}

function pairs(args: string[], single: Set<string>, valued: Set<string>, prefixes: RegExp[]) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (single.has(argument) || prefixes.some(prefix => prefix.test(argument))) continue;
    if (!valued.has(argument) || !args[index + 1]) return false;
    index += 1;
  }
  return true;
}

function journalctl(args: string[]) {
  return pairs(
    args,
    new Set(['--no-pager', '-r', '--reverse', '-k', '--dmesg', '-x', '--catalog', '-q', '--quiet', '--utc', '-b']),
    new Set(['-u', '--unit', '-n', '--lines', '-p', '--priority', '-o', '--output']),
    [/^--(unit|lines|priority|output|since|until)=[A-Za-z0-9_.,:+%@/-]+$/, /^(SYSLOG_IDENTIFIER|_SYSTEMD_UNIT)=[A-Za-z0-9_.@-]+$/],
  );
}

function nvidiaToolArgs(args: string[]) {
  return args.every(argument => /^(-[A-Za-z]+|--[A-Za-z][A-Za-z0-9_-]*(=[A-Za-z0-9_.,:-]+)?)$/.test(argument));
}

const RULES: Record<string, (args: string[]) => boolean> = {
  hostname: exact([], ['-f'], ['--fqdn'], ['-s'], ['--short'], ['-I'], ['--all-ip-addresses']),
  uname: flags(/^(-[asnrvmpio]+|--(all|kernel-name|nodename|kernel-release|kernel-version|machine|processor|hardware-platform|operating-system))$/),
  uptime: flags(/^(-p|-s|--pretty|--since)$/),
  nproc: flags(/^(--all|--ignore=[0-9]+)$/),
  'nvidia-smi': nvidiaSmi,
  ipmitool: exact(['mc', 'info'], ['fru', 'print'], ['sensor', 'list'], ['sdr', 'list'], ['sdr', 'elist'], ['sel', 'list'], ['chassis', 'status']),
  lscpu: flags(/^(-[aeJp]+|--(all|extended|json|online|offline|parse)(=[A-Za-z0-9_,+-]+)?)$/),
  lsblk: flags(/^(-[a-zA-Z]+|--(all|bytes|discard|fs|json|list|nodeps|output-all|paths|perms|scsi|tree|topology)(=[A-Za-z0-9_,+-]+)?)$/),
  free: flags(/^(-[bhkmgtw]+|--(bytes|kibi|mebi|gibi|tebi|human|wide|lohi|total))$/),
  df: flags(/^(-[hTiP]+|--(human-readable|print-type|inodes|portability|total|output)(=[A-Za-z0-9_,+-]+)?)$/),
  vmstat: flags(/^(-[sDd]+|--(stats|disk-sum|disk))$/),
  iostat: flags(/^(-[cdxmkNyz]+|--(compact|dec|human|pretty))$/),
  mpstat: flags(/^(-[A-Za-z]+|--[A-Za-z][A-Za-z-]*)$/),
  lspci: flags(/^(-[Dknmvx]+|-[a-zA-Z]{2,})$/),
  ibstat: nvidiaToolArgs,
  ibstatus: nvidiaToolArgs,
  ibv_devinfo: nvidiaToolArgs,
  ibv_devices: nvidiaToolArgs,
  rdma: exact(['link', 'show'], ['dev', 'show'], ['resource', 'show'], ['system', 'show'], ['statistic', 'show']),
  ip: exact(['address', 'show'], ['addr', 'show'], ['link', 'show'], ['route', 'show'], ['neighbor', 'show'], ['neigh', 'show'], ['-s', 'link', 'show'], ['-br', 'address', 'show'], ['-br', 'link', 'show']),
  ethtool: args => args.length === 1 || (args.length === 2 && /^(-i|-S|-k|-l|-g|-c|-a|-T|-P)$/.test(args[0])),
  systemctl: args => ['status', 'is-active', 'is-failed', 'list-units', 'list-unit-files'].includes(args[0]) && args.slice(1).every(argument => argument === '--no-pager' || /^[A-Za-z0-9_.@*-]+$/.test(argument)),
  journalctl,
  dmesg: flags(/^(-[dHkTwWx]+|--(decode|human|kernel|ctime|reltime|show-delta|notime|userspace|nopager|color=never|level=[A-Za-z0-9_,+-]+|facility=[A-Za-z0-9_,+-]+))$/),
  dmidecode: args => args.length === 0 || (args.length === 2 && ['-t', '--type', '-s', '--string'].includes(args[0]) && /^[A-Za-z0-9_.-]+$/.test(args[1])),
  numactl: exact(['--hardware'], ['--show']),
  sensors: flags(/^(-[Aujf]+|--(no-adapter|unknown|json|fahrenheit))$/),
  ps: args => args.every(argument => /^[A-Za-z0-9_.,:+%-]+$/.test(argument)),
  ss: args => args.every(argument => ARGUMENT.test(argument)) && !args.some(argument => argument === '-K' || argument === '--kill'),
  sacct: args => args.every(argument => ARGUMENT.test(argument)),
  squeue: args => args.every(argument => ARGUMENT.test(argument)),
  sinfo: args => args.every(argument => ARGUMENT.test(argument)),
  sstat: args => args.every(argument => ARGUMENT.test(argument)),
  sdiag: args => args.every(argument => ARGUMENT.test(argument)),
  sreport: args => args.every(argument => ARGUMENT.test(argument)),
  scontrol: args => ['show', 'ping'].includes(args[0]) && args.slice(1).every(argument => ARGUMENT.test(argument)),
};

export function isAllowedDiagnosticArgv(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return false;
  if (!value.every(argument => typeof argument === 'string' && argument && argument.length <= 1024 && ARGUMENT.test(argument))) return false;
  const [program, ...args] = value as string[];
  if (!PROGRAM.test(program)) return false;
  return RULES[program.toLowerCase()]?.(args) === true;
}

export function diagnosticExecArgv(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const params = value as Record<string, unknown>;
  if (Object.keys(params).some(key => key !== 'command')) return undefined;
  if (typeof params.command !== 'string' || !params.command.trim() || params.command.length > 4096 || SHELL_SYNTAX.test(params.command)) return undefined;
  const argv = params.command.trim().split(/\s+/);
  return isAllowedDiagnosticArgv(argv) ? argv : undefined;
}
