# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise the Mosaic adapter with installed BCM and MCP packages on localhost."""

import asyncio
import json
import os
from pathlib import Path
import secrets
import ssl
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client
import httpx2


async def exercise(url, token, notes, context):
    async with httpx2.AsyncClient(headers={"Authorization": f"Bearer {token}"}, verify=context) as http:
        async with streamable_http_client(url + "/mcp", http_client=http) as streams:
            async with ClientSession(*streams) as client:
                await client.initialize()
                names = {tool.name for tool in (await client.list_tools()).tools}
                expected = {"execute_tool", "search_tools", "execute_cmsh", "execute_cmsh_admin",
                            "list_notes", "search_notes", "add_note", "remove_note",
                            "slurm_job_evidence", "redfish_get", "redfish_system_summary",
                            "redfish_thermal", "redfish_power", "redfish_sel", "redfish_firmware"}
                assert expected <= names, expected - names

                async def call(name, arguments):
                    result = await client.call_tool(name, arguments)
                    assert not result.is_error, result
                    return "\n".join(item.text for item in result.content if hasattr(item, "text"))

                assert "Linux" in await call("execute_tool", {
                    "tool_id": "system.uname", "tool_kwargs": {"args": ["-s"]}})
                assert "system.uname" in await call("search_tools", {"query": "uname"})
                await call("add_note", {"subject": "Runtime verification", "content": "Transient local fixture."})
                files = list(notes.rglob("*.md"))
                assert len(files) == 1, files
                assert "Runtime verification" in await call("list_notes", {})
                assert "Transient local fixture" in await call("search_notes", {"query": "Transient"})
                await call("remove_note", {"filename": files[0].name})
                assert not list(notes.rglob("*.md"))
                print("Authenticated MCP discovery, diagnostic, search and notes round-trip pass.")


def exercise_server(use_tls):
    adapter = Path(__file__).resolve().parents[2] / "helm/mosaic-stack/files/bcm-mcp-ssh-server.py"
    with tempfile.TemporaryDirectory(prefix="mosaic-sdk2-") as directory:
        root = Path(directory)
        token = secrets.token_urlsafe(24)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        url = f"{'https' if use_tls else 'http'}://127.0.0.1:{port}"
        context = ssl.create_default_context()
        env = dict(os.environ, MOSAIC_BCM_ADAPTER_HOST="127.0.0.1",
                   MOSAIC_BCM_ADAPTER_PORT=str(port), MOSAIC_BCM_PUBLIC_URL=url,
                   MOSAIC_BCM_MCP_TOKEN=token, MCP_PRELOADED_MODULES="",
                   MCP_NOTES_DIR=str(root / "notes"), MCP_CONFIG_DIR=str(root / "config"),
                   MOSAIC_BCM_CMSH_ADMIN_ENABLED="true", MOSAIC_BCM_REDFISH_ENABLED="true",
                   MOSAIC_BCM_HARDWARE_COMPAT_ENABLED="true", MOSAIC_BCM_HARDWARE_TOKEN=secrets.token_urlsafe(24))
        if use_tls:
            cert, key = root / "cert.pem", root / "key.pem"
            subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                            "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1",
                            "-days", "1", "-keyout", str(key), "-out", str(cert)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            key.chmod(0o600)
            context.load_verify_locations(cert)
            env.update(MOSAIC_BCM_TLS_CERT=str(cert), MOSAIC_BCM_TLS_KEY=str(key),
                       MOSAIC_BCM_EXECUTION_MODE="local")
        with (root / "server.log").open("w+") as log:
            process = subprocess.Popen([sys.executable, str(adapter)], env=env, stdout=log, stderr=log)
            try:
                for _ in range(120):
                    if process.poll() is not None:
                        log.seek(0)
                        raise RuntimeError(log.read())
                    with socket.socket() as sock:
                        if sock.connect_ex(("127.0.0.1", port)) == 0:
                            break
                    time.sleep(.25)
                else:
                    raise TimeoutError("Adapter did not listen")
                for path in ("/mcp", "/list"):
                    try:
                        urllib.request.urlopen(url + path, timeout=5, context=context)
                    except urllib.error.HTTPError as error:
                        assert error.code == 401, (path, error.code)
                    else:
                        raise AssertionError(f"Unauthenticated {path} was accepted")
                # Mosaic sends stateless tools requests without an initialize handshake.
                body = json.dumps({"jsonrpc": "2.0", "id": "probe", "method": "tools/call",
                                   "params": {"name": "execute_tool", "arguments": {
                                       "tool_id": "system.uname", "tool_kwargs": {"args": ["-s"]}}}}).encode()
                request = urllib.request.Request(url + "/mcp", data=body, headers={
                    "Authorization": f"Bearer {token}", "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream"})
                with urllib.request.urlopen(request, timeout=10, context=context) as response:
                    assert "Linux" in response.read().decode()
                asyncio.run(exercise(url, token, root / "notes", context))
                print("MCP and Hardware Agent routes preserve authentication.")
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


if __name__ == "__main__":
    for use_tls in (False, True):
        exercise_server(use_tls)
