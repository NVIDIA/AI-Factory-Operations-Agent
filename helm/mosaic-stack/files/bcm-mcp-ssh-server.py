# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import hmac
import ipaddress
import logging
import re
import shlex
import subprocess
import textwrap
import threading

from bcm_mcp_tools.cli.support_mcp.main import configure_logging
from bcm_mcp_tools.cli.support_mcp.options import get_env_bool, get_env_int, get_env_str
from bcm_mcp_tools.notes import NotesManager
from bcm_mcp_tools.server import BCMServer
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse


def valid_hostname(hostname: str) -> bool:
    return 0 < len(hostname) <= 63 and hostname[0].isalnum() and all(c.isalnum() or c == "-" for c in hostname)


def parse_device_list(output: str) -> list[dict[str, str]]:
    devices = []
    for line in output.splitlines():
        fields = line.split()
        if len(fields) >= 5 and fields[0] == "PhysicalNode" and "*" not in fields[1]:
            devices.append({"hostname": fields[1], "internal_ip": fields[4], "type": fields[0]})
    return devices


def parse_bmc_lookup(output: str) -> dict[str, str] | None:
    entry: dict[str, str] | None = None
    pending = ""
    for raw in output.splitlines():
        line = raw.strip()
        if line.startswith("===") and line.endswith("==="):
            entry = {"hostname": line.strip("= ")}
            pending = ""
        elif line.startswith("+(") and ") " in line:
            command = line.split(") ", 1)[1]
            pending = {
                "get username": "bmc_username",
                "get password": "bmc_password",
            }.get(command, "bmc_ip" if command.startswith("list bmc") and "-f ip" in command else "")
        elif entry is not None and pending:
            if pending == "bmc_ip":
                try:
                    value = str(ipaddress.IPv4Address(line))
                except ipaddress.AddressValueError:
                    continue
            else:
                value = line
            entry[pending] = value
            pending = ""
    required = ("hostname", "bmc_ip", "bmc_username", "bmc_password")
    return entry if entry and all(entry.get(key) for key in required) else None


def last_cmsh_value(output: str) -> str | None:
    lines = [line.strip() for line in output.splitlines() if line.strip() and not line.startswith("+(") and "not found" not in line.lower()]
    return lines[-1] if lines else None


class StaticTokenVerifier:
    def __init__(self, token: str):
        self.token = token

    async def verify_token(self, token: str) -> AccessToken | None:
        if not hmac.compare_digest(token, self.token):
            return None
        return AccessToken(token=token, client_id="mosaic-openclaw", scopes=["bcm"])


class MosaicBCMServer(BCMServer):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.cmsh_enabled = get_env_bool("MOSAIC_BCM_CMSH_ENABLED", False)
        self.cmsh_admin_enabled = get_env_bool("MOSAIC_BCM_CMSH_ADMIN_ENABLED", False)
        self.cmsh_username = get_env_str("MOSAIC_BCM_CMSH_USERNAME", "aichatbotuser") or "aichatbotuser"
        self.cmsh_profile = get_env_str("MOSAIC_BCM_CMSH_PROFILE", "readonly") or "readonly"
        self.cmsh_setup_timeout = get_env_int("MOSAIC_BCM_CMSH_SETUP_TIMEOUT", 240)
        self.cmsh_exec_timeout = get_env_int("MOSAIC_BCM_CMSH_EXEC_TIMEOUT", 120)
        self.cmsh_path = get_env_str("MOSAIC_BCM_CMSH_PATH", "/cm/local/apps/cmd/bin/cmsh") or "/cm/local/apps/cmd/bin/cmsh"
        self.hardware_compat_enabled = get_env_bool("MOSAIC_BCM_HARDWARE_COMPAT_ENABLED", False)
        self.bcm_head_host = get_env_str("MOSAIC_BCM_HEAD_HOST", "") or ""
        self._cmsh_ready = False
        self._cmsh_setup_lock = threading.Lock()

    def _ssh(self, script: str, timeout: int) -> subprocess.CompletedProcess[bytes]:
        if not self.bcm_head_host:
            raise RuntimeError("BCM head host is not configured")
        return subprocess.run(
            ["ssh", self.bcm_head_host, "sh -lc " + shlex.quote(script)],
            capture_output=True,
            timeout=timeout,
            check=False,
        )

    def _ensure_cmsh_user(self) -> None:
        if self._cmsh_ready:
            return
        with self._cmsh_setup_lock:
            if self._cmsh_ready:
                return
            user = shlex.quote(self.cmsh_username)
            profile = shlex.quote(self.cmsh_profile)
            cmsh = shlex.quote(self.cmsh_path)
            setup = textwrap.dedent(
                f"""
                if {cmsh} -c 'user; use {user}; get profile' 2>/dev/null | grep -qx {profile}; then
                  exit 0
                fi
                {cmsh} -c 'user; add --use {user}; set profile {profile}; commit' >/dev/null 2>&1
                """
            ).strip()
            result = self._ssh(setup, self.cmsh_setup_timeout)
            if result.returncode != 0:
                error = result.stderr.decode(errors="replace").strip()
                raise RuntimeError(f"failed to configure CMSH readonly user {self.cmsh_username}: {error}")
            self._cmsh_ready = True

    @staticmethod
    def _result(result: subprocess.CompletedProcess[bytes]) -> str:
        status = "OK" if result.returncode == 0 else "ERROR"
        stdout = result.stdout.decode(errors="replace")
        stderr = result.stderr.decode(errors="replace")
        return f"# Result: {status}\n# Exit code: {result.returncode}\n\n# StdOut:\n{stdout}\n# StdErr:\n{stderr}"

    def _run_cmsh(self, commands: str) -> str:
        self._ensure_cmsh_user()
        lines = [line.strip() for line in commands.replace("\r\n", "\n").split("\n")]
        body = "; ".join(line for line in lines if line and not line.startswith("|"))
        command = f"{self.cmsh_path} -c {shlex.quote(body)}"
        script = f"su - {shlex.quote(self.cmsh_username)} -c {shlex.quote(command)}"
        return self._result(self._ssh(script, self.cmsh_exec_timeout))

    def _run_cmsh_admin(self, commands: str) -> str:
        if not self.cmsh_admin_enabled:
            raise RuntimeError("BCM admin CMSH is disabled")
        body = "; ".join(line.strip() for line in commands.replace("\r\n", "\n").split("\n") if line.strip())
        script = f"{shlex.quote(self.cmsh_path)} -c {shlex.quote(body)}"
        return self._result(self._ssh(script, self.cmsh_exec_timeout))

    def _run_hardware_cmsh(self, commands: str) -> str:
        result = self._ssh(f"{shlex.quote(self.cmsh_path)} -c {shlex.quote(commands)}", self.cmsh_exec_timeout)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.decode(errors="replace").strip() or "cmsh failed")
        return result.stdout.decode(errors="replace")

    def hardware_devices(self) -> list[dict[str, str]]:
        return parse_device_list(self._run_hardware_cmsh("device list"))

    def hardware_bmc(self, hostname: str) -> dict[str, str] | None:
        if not valid_hostname(hostname):
            raise ValueError("invalid hostname")
        return parse_bmc_lookup(self._run_hardware_cmsh(
            f"device; foreach -n {hostname} -v (bmcsettings; get username; get password; ..; interfaces; list bmc -f ip)"
        ))

    def hardware_os(self, hostname: str) -> dict[str, str | None] | None:
        if not valid_hostname(hostname):
            raise ValueError("invalid hostname")

        def read(field: str) -> str | None:
            try:
                return last_cmsh_value(self._run_hardware_cmsh(f"device; get {hostname} {field}"))
            except RuntimeError:
                return None

        host_ip = read("ip")
        host_password = read("rootpassword")
        if host_ip is None and host_password is None:
            return None
        return {
            "hostname": hostname,
            "host_ip": host_ip,
            "host_username": read("username") or "root",
            "host_password": host_password,
        }

    def register_hardware_routes(self, token: str) -> None:
        def authorized(request: Request) -> bool:
            return hmac.compare_digest(request.headers.get("authorization", ""), f"Bearer {token}")

        async def invoke(request: Request, call):
            if not authorized(request):
                return JSONResponse({"detail": "unauthorized"}, status_code=401)
            try:
                value = await asyncio.to_thread(call)
            except ValueError as error:
                return JSONResponse({"detail": str(error)}, status_code=400)
            except RuntimeError:
                logging.getLogger("mosaic.bcm").exception("Hardware Agent BCM lookup failed")
                return JSONResponse({"detail": "BCM lookup failed"}, status_code=502)
            if value is None:
                return JSONResponse({"detail": "device not found"}, status_code=404)
            return JSONResponse(value)

        @self.mcp.custom_route("/list", methods=["GET"])
        async def list_devices(request: Request):
            def inventory():
                devices = self.hardware_devices()
                return {"devices": devices, "count": len(devices)}

            return await invoke(request, inventory)

        @self.mcp.custom_route("/lookup/{hostname}", methods=["POST"])
        async def lookup_bmc(request: Request):
            return await invoke(request, lambda: self.hardware_bmc(request.path_params["hostname"]))

        @self.mcp.custom_route("/lookup-os/{hostname}", methods=["POST"])
        async def lookup_os(request: Request):
            return await invoke(request, lambda: self.hardware_os(request.path_params["hostname"]))

    def slurm_job_evidence(self, job_id: str) -> str:
        if not re.fullmatch(r"[0-9]+", job_id):
            raise ValueError("job_id must be numeric")
        metadata = self._run_cmsh(f"wlm use slurm; jobs; show {job_id}")

        def read(field: str) -> str:
            match = re.search(rf"^{field}\s+(/\S+)\s*$", metadata, re.MULTILINE)
            if not match:
                return ""
            result = self._ssh(f"tail -c 20000 -- {shlex.quote(match.group(1))}", self.cmsh_exec_timeout)
            return result.stdout.decode(errors="replace") if result.returncode == 0 else ""

        return f"# Metadata\n{metadata}\n# StdOut\n{read('Stdout file')}\n# StdErr\n{read('Stderr file')}"

    def register_mosaic_tools(self) -> None:
        self.mcp._tool_manager._tools.pop("execute_cmsh", None)  # pylint: disable=protected-access

        @self.mcp.tool()
        async def execute_cmsh(commands: str) -> str:
            return await asyncio.to_thread(self._run_cmsh, commands)

        if self.cmsh_admin_enabled:
            @self.mcp.tool()
            async def execute_cmsh_admin(commands: str) -> str:
                """Execute an approval-gated CMSH change using the configured SSH administrator identity."""
                return await asyncio.to_thread(self._run_cmsh_admin, commands)

        @self.mcp.tool()
        async def slurm_job_evidence(job_id: str) -> str:
            """Return BCM WLM metadata and bounded stdout/stderr for a numeric Slurm job ID."""
            return await asyncio.to_thread(self.slurm_job_evidence, job_id)


def main() -> int:
    host = get_env_str("MOSAIC_BCM_ADAPTER_HOST", "0.0.0.0") or "0.0.0.0"
    port = get_env_int("MOSAIC_BCM_ADAPTER_PORT", 3001)
    token = get_env_str("MOSAIC_BCM_MCP_TOKEN", "") or ""
    hardware_token = get_env_str("MOSAIC_BCM_HARDWARE_TOKEN", "") or ""
    configure_logging(get_env_str("MCP_LOG_LEVEL", "INFO") or "INFO")

    notes = NotesManager(get_env_str("MCP_NOTES_DIR", "/tmp/bcm-mcp-notes") or "/tmp/bcm-mcp-notes")
    notes.initialize()
    server = MosaicBCMServer(
        exec_timeout_seconds=get_env_int("MCP_EXEC_TIMEOUT", 120),
        no_auth=not token,
        auth_token=token or None,
        max_output_lines=get_env_int("MCP_MAX_OUTPUT_LINES", 200),
        max_output_chars=get_env_int("MCP_MAX_OUTPUT_CHARS", 20000),
        preloaded_modules=(get_env_str("MCP_PRELOADED_MODULES", "shared,slurm") or "").split(","),
        cmsh_username=None,
        notes_manager=notes,
    )
    if server.cmsh_admin_enabled and not token:
        raise RuntimeError("MOSAIC_BCM_MCP_TOKEN is required when BCM admin CMSH is enabled")
    if server.hardware_compat_enabled and not hardware_token:
        raise RuntimeError("MOSAIC_BCM_HARDWARE_TOKEN is required when Hardware Agent compatibility is enabled")

    auth = {
        "token_verifier": StaticTokenVerifier(token),
        "auth": AuthSettings(
            issuer_url=f"http://bcm-mcp-tools:{port}",
            resource_server_url=f"http://bcm-mcp-tools:{port}/mcp",
            required_scopes=["bcm"],
        ),
    } if token else {}
    server.mcp = FastMCP("BCM MCP over SSH", host=host, port=port, stateless_http=True, **auth)
    server._register_tools()  # pylint: disable=protected-access
    server.register_mosaic_tools()
    if server.hardware_compat_enabled:
        server.register_hardware_routes(hardware_token)
    logging.getLogger("mosaic.bcm").info("Starting local BCM MCP server on %s:%s", host, port)
    server.mcp.run(transport="streamable-http")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
