# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""HTTPS transport check using the chart image's BCM package and mcp<2 environment."""

import json
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[2]


def main():
    with tempfile.TemporaryDirectory(prefix="bcm-https-", dir=os.environ.get("TMPDIR")) as directory:
        directory = Path(directory)
        cert, key = directory / "cert.pem", directory / "key.pem"
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(cert), "-days", "1",
            "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ], check=True, capture_output=True)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        url = f"https://localhost:{port}"
        env = os.environ | {
            "MOSAIC_BCM_EXECUTION_MODE": "local",
            "MOSAIC_BCM_ADAPTER_HOST": "127.0.0.1",
            "MOSAIC_BCM_ADAPTER_PORT": str(port),
            "MOSAIC_BCM_PUBLIC_URL": url,
            "MOSAIC_BCM_TLS_CERT": str(cert), "MOSAIC_BCM_TLS_KEY": str(key),
            "MOSAIC_BCM_MCP_TOKEN": "ephemeral-test-token",
            "MOSAIC_BCM_CMSH_ENABLED": "false",
            "MOSAIC_BCM_REDFISH_ENABLED": "true",
            "MOSAIC_BCM_CMSH_ADMIN_ENABLED": "true",
            "MOSAIC_BCM_HARDWARE_COMPAT_ENABLED": "true",
            "MOSAIC_BCM_HARDWARE_TOKEN": "ephemeral-hardware-token",
            "MOSAIC_BCM_HEAD_HOST": "",
            "MCP_PRELOADED_MODULES": "",
            "MCP_NOTES_DIR": str(directory / "notes"),
        }
        context = ssl.create_default_context(cafile=str(cert))

        def request(payload, token="ephemeral-test-token", tls=context):
            req = urllib.request.Request(url + "/mcp", data=json.dumps(payload).encode(), headers={
                "Authorization": f"Bearer {token}", "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            })
            with urllib.request.urlopen(req, context=tls, timeout=10) as response:
                body = response.read().decode()
            return json.loads(next(line[6:] for line in body.splitlines() if line.startswith("data: ")))

        payload = {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}
        with (directory / "server.log").open("w+") as log:
            process = subprocess.Popen([sys.executable, str(ROOT / "helm/mosaic-stack/files/bcm-mcp-ssh-server.py")],
                                       env=env, stdout=log, stderr=log)
            try:
                for _ in range(150):
                    if process.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read())
                    try:
                        tools = request(payload)["result"]["tools"]
                        break
                    except urllib.error.URLError:
                        time.sleep(0.1)
                else:
                    raise TimeoutError("HTTPS MCP did not become ready")
                names = {tool["name"] for tool in tools}
                assert {"execute_tool", "execute_cmsh", "execute_cmsh_admin", "slurm_job_evidence",
                        "redfish_get", "redfish_system_summary"} <= names, names
                for token in ("", "wrong-token"):
                    try:
                        request(payload, token=token)
                        raise AssertionError("unauthenticated request succeeded")
                    except urllib.error.HTTPError as error:
                        assert error.code == 401, error.code
                try:
                    request(payload, tls=ssl.create_default_context())
                    raise AssertionError("untrusted certificate succeeded")
                except urllib.error.URLError as error:
                    assert isinstance(error.reason, ssl.SSLCertVerificationError), error
                result = request({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
                    "name": "execute_tool", "arguments": {"tool_id": "system.uname", "context": {}},
                }})["result"]
                assert not result.get("isError"), result
                assert "Linux" in json.dumps(result), result
                plugin = ROOT / "helm/mosaic-stack/files/openclaw-seed/extensions/bcm/index.ts"
                client = """
                    import assert from 'node:assert/strict';
                    import { registerHooks } from 'node:module';
                    const hooks = registerHooks({ resolve(s, c, next) {
                        return s === 'openclaw/plugin-sdk/plugin-entry'
                            ? { url: 'data:text/javascript,export const definePluginEntry = x => x;', shortCircuit: true }
                            : next(s, c);
                    }});
                    const plugin = (await import(process.env.TRIAL_PLUGIN)).default;
                    hooks.deregister();
                    const tools = new Map();
                    plugin.register({ pluginConfig: {
                        mcpUrl: process.env.TRIAL_URL + '/mcp', authToken: 'ephemeral-test-token',
                        mcpMode: 'external', headHost: 'unused-head.invalid',
                        subagentEventsUrl: 'http://127.0.0.1:1/events',
                    }, session: { state: { registerSessionExtension() {} } },
                        registerTrustedToolPolicy() {}, registerTool: t => tools.set(t.name, t) });
                    const result = await tools.get('bcm_execute_tool').execute('trial', {tool_id: 'system.uname'});
                    assert.match(JSON.stringify(result), /Linux/);
                """
                subprocess.run(["node", "--experimental-strip-types", "--input-type=module", "--eval", client],
                               env=env | {"NODE_EXTRA_CA_CERTS": str(cert), "TRIAL_URL": url,
                                          "TRIAL_PLUGIN": plugin.as_uri()}, check=True, timeout=30)
                print("Passed: trusted TLS, rejected untrusted TLS/tokens, tool interfaces, local diagnostic execution without head SSH.")
            finally:
                process.terminate()
                process.wait(timeout=10)


if __name__ == "__main__":
    main()
