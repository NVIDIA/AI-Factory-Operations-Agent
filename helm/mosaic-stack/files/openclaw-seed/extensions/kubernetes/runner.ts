// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";

export function kubectlArgv(
  kubeconfig: string,
  args: string[],
  server?: string,
  tlsServerName?: string,
) {
  return [
    "--kubeconfig", kubeconfig,
    ...(server ? ["--server", server] : []),
    ...(tlsServerName ? ["--tls-server-name", tlsServerName] : []),
    ...args,
  ];
}

export function runKubectl(
  command: string,
  args: string[],
  kubeconfig: string,
  timeoutMs: number,
  maxOutputBytes: number,
  stdin?: string,
  server?: string,
  tlsServerName?: string,
) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, kubectlArgv(kubeconfig, args, server, tlsServerName), {
      env: { ...process.env, KUBECONFIG: kubeconfig },
      shell: false,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (error?: Error, code = -1) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else {
        resolve({
          code,
          stdout: stdout.replaceAll(kubeconfig, "<kubeconfig>"),
          stderr: stderr.replaceAll(kubeconfig, "<kubeconfig>"),
        });
      }
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill("SIGKILL");
        finish(new Error("kubectl output exceeded " + maxOutputBytes + " bytes"));
      } else if (target === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };

    child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
    if (stdin !== undefined) child.stdin?.end(stdin);
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(undefined, code ?? -1));
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("kubectl timed out after " + timeoutMs + " ms"));
    }, timeoutMs);
  });
}
