// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import type { RemoteHost } from "./policy.ts";

type SshSettings = {
  command: string;
  keyPath: string;
  knownHostsPath: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

export function sshResult(payload: Record<string, unknown>) {
  const details = payload.exitCode === 127 ? {
    ...payload,
    recovery: {
      reason: "remote_command_lookup_failed",
      guidance: "Remote command lookup remains unresolved. Required next step in Edit or Auto: use run_remote_ssh on this same configured host to check environment initialization before switching tools or answering. On a module-managed host, discover modules with argv [\"bash\",\"-lc\",\"module avail\"]. Load a relevant discovered module and invoke the dependent command inside that same shell. Repeat this initialization inside every later SSH call that needs the module, including calls with changed arguments or targets; a new login shell does not retain previous module loads. Do not guess module versions or executable names. A lookup failure after earlier success requires checking initialization in the failing invocation. Do not infer uninstallation from exit 127, use sandbox lookups as remote evidence, or hand off checks you can perform yourself. Inspect the correctly initialized retry before answering. Report an explicit access or validation denial without bypassing it.",
    },
  } : payload;
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
    details,
  };
}

export function buildSshArgs(settings: SshSettings, host: RemoteHost, remoteCommand: string) {
  return [
    "-F", "/dev/null",
    "-i", settings.keyPath,
    "-p", String(host.port),
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "IdentityAgent=none",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "PreferredAuthentications=publickey",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${settings.knownHostsPath}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "ProxyCommand=none",
    "-o", "ProxyJump=none",
    "-o", "ForwardAgent=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "PermitLocalCommand=no",
    "-o", "RequestTTY=no",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", `ConnectTimeout=${Math.max(1, Math.min(30, Math.ceil(settings.timeoutMs / 1000)))}`,
    "-o", `ServerAliveInterval=${Math.max(1, Math.min(30, Math.ceil(settings.timeoutMs / 3000)))}`,
    "-o", "ServerAliveCountMax=2",
    "--",
    `${host.user}@${host.address}`,
    remoteCommand,
  ];
}

export function redactSshOutput(value: string, settings: Pick<SshSettings, "keyPath" | "knownHostsPath">) {
  return value
    .replaceAll(settings.keyPath, "<ssh-private-key>")
    .replaceAll(settings.knownHostsPath, "<ssh-known-hosts>")
    .replaceAll("/var/run/mosaic-ssh", "<ssh-credentials>");
}

export function runSsh(settings: SshSettings, host: RemoteHost, remoteCommand: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(settings.command, buildSshArgs(settings, host, remoteCommand), {
      env: {
        HOME: process.env.HOME || "/tmp",
        LANG: process.env.LANG || "C.UTF-8",
        PATH: process.env.PATH || "/usr/bin:/bin",
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error, code = -1) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve({
        code,
        stdout: redactSshOutput(stdout, settings),
        stderr: redactSshOutput(stderr, settings),
      });
    };
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > settings.maxOutputBytes) {
        child.kill("SIGKILL");
        finish(new Error(`remote SSH output exceeded ${settings.maxOutputBytes} bytes`));
      } else if (stream === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };
    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(undefined, code ?? -1));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`remote SSH command timed out after ${settings.timeoutMs} ms`));
    }, settings.timeoutMs);
  });
}
