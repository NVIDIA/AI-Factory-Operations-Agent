# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import asyncio
import base64
import hmac
import ipaddress
import json
import logging
import os
import re
import selectors
import shlex
import ssl
import subprocess
import textwrap
import threading
import time
import urllib.error
import urllib.request

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
    return entry


def last_cmsh_value(output: str) -> str | None:
    lines = [line.strip() for line in output.splitlines() if line.strip() and not line.startswith("+(") and "not found" not in line.lower()]
    return lines[-1] if lines else None


class RedfishError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class RedfishPolicy:
    """Read-only Redfish allowlist enforced before any BMC credential is resolved."""

    _ID = r"[A-Za-z0-9_-][A-Za-z0-9._-]*"
    _SUB = rf"(?:/{_ID})*"
    _LOGS = rf"/LogServices(?:/{_ID}(?:/Entries(?:/{_ID})?)?)?"
    ALLOWED = tuple(re.compile(f"/redfish/v1{pattern}") for pattern in (
        "",
        "/(?:Systems|Chassis|Managers)",
        rf"/Systems/{_ID}",
        rf"/Systems/{_ID}/(?:Processors|Memory|Storage|EthernetInterfaces){_SUB}",
        rf"/Systems/{_ID}{_LOGS}",
        rf"/Chassis/{_ID}",
        rf"/Chassis/{_ID}/(?:Thermal|ThermalSubsystem|Power|PowerSubsystem|Sensors){_SUB}",
        rf"/Managers/{_ID}",
        rf"/Managers/{_ID}{_LOGS}",
        rf"/Managers/{_ID}/EthernetInterfaces{_SUB}",
        rf"/UpdateService/FirmwareInventory{_SUB}",
        rf"/TaskService/Tasks{_SUB}",
    ))
    DENIED_SEGMENTS = frozenset({
        "accountservice", "sessionservice", "certificateservice", "eventservice",
        "actions", "secureboot", "virtualmedia",
    })
    QUERY = {
        "$expand": re.compile(r"\.(?:\(\$levels=1\))?"),
        "$top": re.compile(r"[0-9]{1,4}"),
        "$skip": re.compile(r"[0-9]{1,7}"),
    }

    @classmethod
    def normalize(cls, path: str) -> str | None:
        if not isinstance(path, str) or len(path) > 512 or any(c in path for c in "%#\\\"' \t\r\n"):
            return None
        resource, separator, query = path.partition("?")
        if separator and not query:
            return None
        if "//" in resource or ".." in resource or "/bios/settings" in resource.lower():
            return None
        if len(resource) > len("/redfish/v1") and resource.endswith("/"):
            resource = resource[:-1]
        if any(segment.lower() in cls.DENIED_SEGMENTS for segment in resource.split("/")):
            return None
        if not any(pattern.fullmatch(resource) for pattern in cls.ALLOWED):
            return None
        params = []
        for item in query.split("&") if query else []:
            name, separator, value = item.partition("=")
            if not separator or name not in cls.QUERY or not cls.QUERY[name].fullmatch(value):
                return None
            params.append(item)
        if resource == "/redfish/v1" and params:
            return None
        return resource + ("?" + "&".join(params) if params else "")

    @classmethod
    def is_allowed(cls, method: str, path: str) -> bool:
        return method == "GET" and cls.normalize(path) is not None


REDFISH_SECRET_SUFFIXES = ("password", "token", "secret")
REDFISH_METADATA = ("@odata.context", "@odata.etag", "@odata.type")
REDFISH_MAX_CHARS = 32000
REDFISH_MAX_BYTES = 8 * 1024 * 1024
REDFISH_MAX_PAGES = 50
REDFISH_MAX_LOG_SERVICES = 10
REDFISH_MAX_UNQUERIED_ENTRIES = 1000
REDFISH_SKIPPED_LOGS = frozenset({"debugtokenservice", "diagnosticlog", "dump", "fdr", "journal"})
CURL_ERRORS = {6: "BMC address could not be resolved", 7: "BMC is unreachable", 28: "BMC request timed out",
               35: "BMC TLS handshake failed", 60: "BMC TLS certificate verification failed",
               63: "BMC response exceeds the size limit"}


def redfish_secret_key(key: str) -> bool:
    key = key.lower().replace("-", "").replace("_", "")
    return key.endswith((*REDFISH_SECRET_SUFFIXES, "apikey")) or key in {
        "authorization", "proxyauthorization", "cookie", "setcookie",
    }


def scrub_redfish_header(header) -> str:
    if not isinstance(header, str):
        return "[redacted]"
    name, separator, _ = header.partition(":")
    if not separator:
        return "[redacted]"
    return f"{name}: [redacted]" if redfish_secret_key(name.strip()) else header


def scrub_redfish(value):
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key in REDFISH_METADATA:
                continue
            if redfish_secret_key(key):
                item = "[redacted]"
            elif key.lower() == "httpheaders":
                item = [scrub_redfish_header(header) for header in item] if isinstance(item, list) else "[redacted]"
            elif key.lower() == "jsonbody" and isinstance(item, str) and item:
                try:
                    item = json.dumps(scrub_redfish(json.loads(item)))
                except ValueError:
                    item = "[redacted]"
            else:
                item = scrub_redfish(item)
            result[key] = item
        return result
    if isinstance(value, list):
        return [scrub_redfish(item) for item in value]
    return value


def confine_redfish(value):
    """Reduce embedded resources outside the allowlist, such as $expand results, to bare links."""
    if isinstance(value, list):
        return [confine_redfish(item) for item in value]
    if not isinstance(value, dict):
        return value
    link = value.get("@odata.id")
    if isinstance(link, str) and set(value) - {"@odata.id"} and RedfishPolicy.normalize(link.split("#", 1)[0]) is None:
        return {"@odata.id": link}
    return {key: confine_redfish(item) for key, item in value.items()}


def curl_user_config(username: str, password: str) -> bytes:
    if any(c in username + password for c in "\r\n\0"):
        raise RedfishError(502, "BMC credentials in BCM are malformed")
    escaped = f"{username}:{password}".replace("\\", "\\\\").replace('"', '\\"')
    return f'user = "{escaped}"\n'.encode()


def redfish_member_paths(data: dict) -> list[str]:
    return [m["@odata.id"] for m in data.get("Members", []) if isinstance(m, dict) and isinstance(m.get("@odata.id"), str)]


def health(item: dict) -> str | None:
    status = item.get("Status") or {}
    return status.get("Health") if isinstance(status, dict) else None


def present(item: dict) -> bool:
    status = item.get("Status") or {}
    return not isinstance(status, dict) or status.get("State") != "Absent"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


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
        self.redfish_enabled = get_env_bool("MOSAIC_BCM_REDFISH_ENABLED", False)
        self.redfish_verify_tls = get_env_bool("MOSAIC_BCM_REDFISH_VERIFY_TLS", False)
        self.redfish_timeout = get_env_int("MOSAIC_BCM_REDFISH_TIMEOUT", 60)
        self.redfish_via_head_node = get_env_bool("MOSAIC_BCM_REDFISH_VIA_HEAD_NODE", True)
        self._redfish_members: dict[tuple[str, str], list[str]] = {}
        self._cmsh_ready = False
        self._cmsh_setup_lock = threading.Lock()

    def _ssh(self, script: str, timeout: int, stdin: bytes | None = None,
             max_output_bytes: int | None = None) -> subprocess.CompletedProcess[bytes]:
        if not self.bcm_head_host:
            raise RuntimeError("BCM head host is not configured")
        command = ["ssh", self.bcm_head_host, "sh -lc " + shlex.quote(script)]
        if max_output_bytes is None:
            return subprocess.run(command, capture_output=True, timeout=timeout, check=False, input=stdin)
        deadline = time.monotonic() + timeout
        with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL) as process:
            try:
                output = bytearray()
                pending = memoryview(stdin or b"")
                with selectors.DefaultSelector() as selector:
                    selector.register(process.stdout, selectors.EVENT_READ)
                    if pending:
                        os.set_blocking(process.stdin.fileno(), False)
                        selector.register(process.stdin, selectors.EVENT_WRITE)
                    else:
                        process.stdin.close()
                    while selector.get_map():
                        remaining = deadline - time.monotonic()
                        events = selector.select(max(0, remaining))
                        if remaining <= 0 or not events:
                            raise subprocess.TimeoutExpired(command, timeout)
                        for key, _ in events:
                            if key.fileobj is process.stdin:
                                try:
                                    pending = pending[os.write(key.fd, pending):]
                                except BlockingIOError:
                                    continue
                                except BrokenPipeError:
                                    pending = memoryview(b"")
                                if not pending:
                                    selector.unregister(process.stdin)
                                    process.stdin.close()
                            else:
                                chunk = os.read(key.fd, min(65536, max_output_bytes + 1 - len(output)))
                                if not chunk:
                                    selector.unregister(process.stdout)
                                output.extend(chunk)
                                if len(output) > max_output_bytes:
                                    raise RedfishError(502, "BMC response exceeds the size limit")
                code = process.wait(timeout=max(0, deadline - time.monotonic()))
                return subprocess.CompletedProcess(command, code, bytes(output), b"")
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()

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
        entry = parse_bmc_lookup(self._run_hardware_cmsh(
            f"device; foreach -n {hostname} -v (bmcsettings; get username; get password; ..; interfaces; list bmc -f ip)"
        ))
        if not entry or not entry.get("bmc_ip"):
            return None
        missing = [field for field in ("username", "password") if not entry.get(f"bmc_{field}")]
        if missing:
            category = self._run_hardware_cmsh(f"device; get {hostname} category").strip()
            if category:
                for field in missing:
                    value = self._run_hardware_cmsh(
                        f"category; use {shlex.quote(category)}; bmcsettings; get {field}"
                    ).strip()
                    if value:
                        entry[f"bmc_{field}"] = value
        return entry if all(entry.get(f"bmc_{field}") for field in ("username", "password")) else None

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

    def _redfish_bmc(self, hostname: str) -> dict[str, str]:
        bmc = self.hardware_bmc(hostname)
        if bmc is None:
            raise RedfishError(404, f"no BMC address and credentials are configured in BCM for {hostname}")
        return bmc

    def _redfish_fetch(self, bmc: dict[str, str], path: str) -> tuple[int, bytes]:
        url = f"https://{bmc['bmc_ip']}{path}"
        if self.redfish_via_head_node:
            command = ["curl", "-sS", "--proto", "=https", "--max-time", str(self.redfish_timeout),
                       "--max-filesize", str(REDFISH_MAX_BYTES),
                       "-H", "Accept: application/json", "-K", "/dev/stdin", "-w", "\n%{http_code}"]
            if not self.redfish_verify_tls:
                command.append("-k")
            try:
                result = self._ssh(shlex.join(command + [url]), self.redfish_timeout + 30,
                                   curl_user_config(bmc["bmc_username"], bmc["bmc_password"]),
                                   max_output_bytes=REDFISH_MAX_BYTES + 4)
            except subprocess.TimeoutExpired as error:
                raise RedfishError(504, "BMC request timed out") from error
            if result.returncode != 0:
                raise RedfishError(502, CURL_ERRORS.get(result.returncode, "BMC request through the BCM head node failed"))
            body, _, code = result.stdout.rpartition(b"\n")
            return int(code) if code.isdigit() else 502, body
        context = ssl.create_default_context()
        if not self.redfish_verify_tls:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        credentials = base64.b64encode(f"{bmc['bmc_username']}:{bmc['bmc_password']}".encode()).decode()
        request = urllib.request.Request(url, headers={"Accept": "application/json", "Authorization": f"Basic {credentials}"})
        opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=context), _NoRedirect())
        try:
            with opener.open(request, timeout=self.redfish_timeout) as response:
                return response.status, response.read(REDFISH_MAX_BYTES + 1)
        except urllib.error.HTTPError as error:
            return error.code, b""
        except (urllib.error.URLError, OSError) as error:
            raise RedfishError(502, "BMC is unreachable from the BCM MCP service") from error

    def _redfish_read(self, bmc: dict[str, str], path: str) -> dict:
        allowed = RedfishPolicy.normalize(path)
        if allowed is None:
            raise RedfishError(403, f"{path} is not permitted by the read-only Redfish policy")
        status, body = self._redfish_fetch(bmc, allowed)
        if status != 200:
            raise RedfishError(status if 400 <= status < 600 else 502, f"BMC returned HTTP {status} for {allowed}")
        if len(body) > REDFISH_MAX_BYTES:
            raise RedfishError(502, f"BMC response for {allowed} is too large")
        try:
            data = json.loads(body)
        except ValueError as error:
            raise RedfishError(502, f"BMC returned non-JSON content for {allowed}") from error
        data = scrub_redfish(confine_redfish(data))
        return data if isinstance(data, dict) else {"value": data}

    def _redfish_members_of(self, hostname: str, bmc: dict[str, str], collection: str) -> list[str]:
        key = (hostname, collection)
        if key not in self._redfish_members:
            members = redfish_member_paths(self._redfish_read(bmc, f"/redfish/v1/{collection}"))
            self._redfish_members[key] = [path for path in members if RedfishPolicy.normalize(path) == path]
        return self._redfish_members[key]

    def _redfish_chassis(self, hostname: str, bmc: dict[str, str], chassis: str) -> str:
        if chassis:
            path = f"/redfish/v1/Chassis/{chassis}"
            if RedfishPolicy.normalize(path) != path:
                raise ValueError("invalid chassis id")
            return path
        for system in self._redfish_members_of(hostname, bmc, "Systems")[:1]:
            linked = redfish_member_paths({"Members": (self._redfish_read(bmc, system).get("Links") or {}).get("Chassis", [])})
            if linked:
                return linked[0]
        members = self._redfish_members_of(hostname, bmc, "Chassis")
        if not members:
            raise RedfishError(404, "the BMC reports no chassis")
        return members[0]

    def redfish_get(self, hostname: str, path: str) -> dict:
        if RedfishPolicy.normalize(path) is None:
            raise RedfishError(403, f"{path} is not permitted by the read-only Redfish policy")
        return self._redfish_read(self._redfish_bmc(hostname), path)

    def redfish_system_summary(self, hostname: str) -> dict:
        bmc = self._redfish_bmc(hostname)
        systems = []
        for path in self._redfish_members_of(hostname, bmc, "Systems")[:4]:
            data = self._redfish_read(bmc, path)
            status = data.get("Status") or {}
            systems.append({
                "id": data.get("Id"), "powerState": data.get("PowerState"),
                "health": status.get("Health"), "healthRollup": status.get("HealthRollup"), "state": status.get("State"),
                "manufacturer": data.get("Manufacturer"), "model": data.get("Model"), "serialNumber": data.get("SerialNumber"),
                "biosVersion": data.get("BiosVersion"), "lastResetTime": data.get("LastResetTime"),
                "bootProgress": (data.get("BootProgress") or {}).get("LastState"),
            })
        return {"hostname": hostname, "systems": systems}

    def redfish_thermal(self, hostname: str, chassis: str = "") -> dict:
        bmc = self._redfish_bmc(hostname)
        base = self._redfish_chassis(hostname, bmc, chassis)
        try:
            data = self._redfish_read(bmc, f"{base}/Thermal")
            temps = [{"name": t.get("Name"), "readingCelsius": t.get("ReadingCelsius"),
                      "upperCritical": t.get("UpperThresholdCritical"), "upperFatal": t.get("UpperThresholdFatal"),
                      "health": health(t)} for t in data.get("Temperatures", []) if present(t) and t.get("ReadingCelsius") is not None]
            fans = [{"name": f.get("Name"), "reading": f.get("Reading"), "units": f.get("ReadingUnits"),
                     "lowerCritical": f.get("LowerThresholdCritical"), "health": health(f)}
                    for f in data.get("Fans", []) if present(f) and f.get("Reading") is not None]
            source = "Thermal"
        except RedfishError as error:
            if error.status not in (404, 405):
                raise
            metrics = self._redfish_read(bmc, f"{base}/ThermalSubsystem/ThermalMetrics")
            temps = [{"name": t.get("DeviceName") or t.get("DataSourceUri"), "readingCelsius": t.get("Reading"),
                      "upperCritical": None, "upperFatal": None, "health": None}
                     for t in metrics.get("TemperatureReadingsCelsius", []) if t.get("Reading") is not None]
            fan_data = self._redfish_read(bmc, f"{base}/ThermalSubsystem/Fans?$expand=.($levels=1)")
            fans = [{"name": f.get("Name") or f.get("Id"), "reading": (f.get("SpeedPercent") or {}).get("Reading"),
                     "units": "%", "lowerCritical": None, "health": health(f)}
                    for f in fan_data.get("Members", []) if isinstance(f, dict) and present(f)]
            source = "ThermalSubsystem"

        def margin(row):
            limit = row["upperCritical"] if row["upperCritical"] is not None else row["upperFatal"]
            return (0, limit - row["readingCelsius"]) if limit is not None else (1, -row["readingCelsius"])

        readings = [f["reading"] for f in fans if isinstance(f["reading"], (int, float))]
        return {
            "hostname": hostname, "chassis": base.rsplit("/", 1)[1], "source": source,
            "temperatureCount": len(temps),
            "unhealthyTemperatures": [t for t in temps if t["health"] not in (None, "OK")],
            "closestToLimit": sorted(temps, key=margin)[:15],
            "fanCount": len(fans),
            "unhealthyFans": [f for f in fans if f["health"] not in (None, "OK")],
            "fanReadingRange": [min(readings), max(readings)] if readings else None,
            "slowestFans": sorted((f for f in fans if isinstance(f["reading"], (int, float))), key=lambda f: f["reading"])[:5],
        }

    def redfish_power(self, hostname: str, chassis: str = "") -> dict:
        bmc = self._redfish_bmc(hostname)
        base = self._redfish_chassis(hostname, bmc, chassis)
        result: dict = {"hostname": hostname, "chassis": base.rsplit("/", 1)[1], "powerControl": [], "powerSupplies": []}
        try:
            data = self._redfish_read(bmc, f"{base}/Power")
            for control in data.get("PowerControl", []):
                metrics = control.get("PowerMetrics") or {}
                result["powerControl"].append({
                    "name": control.get("Name"), "consumedWatts": control.get("PowerConsumedWatts"),
                    "averageWatts": metrics.get("AverageConsumedWatts"), "maxWatts": metrics.get("MaxConsumedWatts"),
                    "capacityWatts": control.get("PowerCapacityWatts"), "health": health(control),
                })
            for supply in data.get("PowerSupplies", []):
                result["powerSupplies"].append({
                    "name": supply.get("Name"), "health": health(supply), "present": present(supply),
                    "inputWatts": supply.get("PowerInputWatts"), "outputWatts": supply.get("PowerOutputWatts"),
                    "capacityWatts": supply.get("PowerCapacityWatts"),
                })
            result["unhealthyVoltages"] = [{"name": v.get("Name"), "readingVolts": v.get("ReadingVolts"), "health": health(v)}
                                           for v in data.get("Voltages", []) if present(v) and health(v) not in (None, "OK")]
        except RedfishError as error:
            if error.status not in (404, 405):
                raise
        if not result["powerSupplies"]:
            try:
                supplies = self._redfish_read(bmc, f"{base}/PowerSubsystem/PowerSupplies?$expand=.($levels=1)")
            except RedfishError as error:
                if error.status not in (404, 405):
                    raise
            else:
                result["powerSupplies"] = [{
                    "name": s.get("Name") or s.get("Id"), "health": health(s), "present": present(s),
                    "capacityWatts": s.get("PowerCapacityWatts"), "model": s.get("Model"),
                } for s in supplies.get("Members", []) if isinstance(s, dict)]
        return result

    def _redfish_entries(self, bmc: dict[str, str], path: str, limit: int) -> tuple[list[dict], object, bool]:
        """Read up to limit members from path, following bounded nextLink pages; report whether more exist."""
        members: list[dict] = []
        count = None
        page = path
        for _ in range(REDFISH_MAX_PAGES):
            data = self._redfish_read(bmc, page)
            if count is None:
                count = data.get("Members@odata.count")
            members += [m for m in data.get("Members", []) if isinstance(m, dict)]
            link = data.get("Members@odata.nextLink")
            if not isinstance(link, str) or not link or len(members) >= limit:
                return members[:limit], count, len(members) > limit or bool(isinstance(link, str) and link)
            page = link
        return members[:limit], count, True

    def redfish_sel(self, hostname: str, limit: int = 50) -> dict:
        limit = max(1, min(int(limit), 200))
        bmc = self._redfish_bmc(hostname)
        services: list[str] = []
        errors: list[dict] = []

        def source_of(path: str) -> str:
            return path.removeprefix("/redfish/v1/").replace("/LogServices/", "/")

        for collection in ("Managers", "Systems"):
            for member in self._redfish_members_of(hostname, bmc, collection):
                try:
                    listed = redfish_member_paths(self._redfish_read(bmc, f"{member}/LogServices"))
                except RedfishError as error:
                    if error.status != 404:
                        errors.append({"source": source_of(member), "status": error.status, "error": str(error)})
                    continue
                services += [path for path in listed
                             if path.rsplit("/", 1)[1].lower() not in REDFISH_SKIPPED_LOGS and path not in services]
        if len(services) > REDFISH_MAX_LOG_SERVICES:
            errors.append({"source": None, "status": None,
                           "error": f"{len(services) - REDFISH_MAX_LOG_SERVICES} more log services were not read"})
        entries, sources = [], []
        for service in services[:REDFISH_MAX_LOG_SERVICES]:
            source = source_of(service)
            try:
                try:
                    members, count, more = self._redfish_entries(bmc, f"{service}/Entries?$top={limit}", limit)
                except RedfishError as error:
                    if error.status != 400:
                        raise
                    # Some log services reject every query parameter; read them unqueried instead.
                    members, more = self._redfish_entries(bmc, f"{service}/Entries", REDFISH_MAX_UNQUERIED_ENTRIES)[::2]
                    count = None
                if isinstance(count, int) and count > limit:
                    newest, _, _ = self._redfish_entries(bmc, f"{service}/Entries?$skip={count - limit}&$top={limit}", limit)
                    members += newest
                    if len(newest) < limit:
                        errors.append({"source": source, "status": None,
                                       "error": "fewer of the newest entries were returned than requested"})
                elif more:
                    errors.append({"source": source, "status": None,
                                   "error": "more entries exist than could be read, so the newest may be missing"})
            except RedfishError as error:
                errors.append({"source": source, "status": error.status, "error": str(error)})
                continue
            sources.append(source)
            for entry in members:
                entries.append({
                    "created": entry.get("Created"), "severity": entry.get("Severity"),
                    "message": str(entry.get("Message") or "")[:240], "source": source, "id": entry.get("Id"),
                })
        failed = [e for e in errors if e["status"] is not None]
        if failed and not sources:
            raise RedfishError(failed[0]["status"], "no BMC event log could be read: "
                               + "; ".join(f"{e['source']}: {e['error']}" for e in failed[:5]))
        unique = {(e["source"], e["id"]): e for e in entries}.values()
        newest = sorted(unique, key=lambda e: str(e["created"] or ""), reverse=True)[:limit]
        result = {"hostname": hostname, "sources": sources, "entries": newest, "complete": not errors}
        if errors:
            result["errors"] = errors
        return result

    def redfish_firmware(self, hostname: str) -> dict:
        bmc = self._redfish_bmc(hostname)
        try:
            members = self._redfish_read(bmc, "/redfish/v1/UpdateService/FirmwareInventory?$expand=.($levels=1)").get("Members", [])
            if members and set(members[0]) <= {"@odata.id"}:
                raise RedfishError(501, "expand not honored")
        except RedfishError:
            paths = redfish_member_paths(self._redfish_read(bmc, "/redfish/v1/UpdateService/FirmwareInventory"))
            members = [self._redfish_read(bmc, path) for path in paths[:100]]
        return {"hostname": hostname, "firmware": [
            {"id": m.get("Id"), "name": m.get("Name"), "version": m.get("Version"),
             "updateable": m.get("Updateable"), "health": health(m)}
            for m in members if isinstance(m, dict)
        ]}

    def redfish_tool(self, call, *args) -> str:
        try:
            payload = call(*args)
        except RedfishError as error:
            payload = {"error": str(error), "status": error.status}
        except ValueError as error:
            payload = {"error": str(error), "status": 400}
        except RuntimeError:
            logging.getLogger("mosaic.bcm").exception("Redfish BCM lookup failed")
            payload = {"error": "BCM lookup for the BMC failed", "status": 502}
        text = json.dumps(payload, separators=(",", ":"), default=str)
        entries = payload.get("entries") if isinstance(payload, dict) else None
        while len(text) > REDFISH_MAX_CHARS and isinstance(entries, list) and entries:
            dropped = max(1, len(entries) // 10)
            del entries[-dropped:]
            payload["omittedOlderEntries"] = payload.get("omittedOlderEntries", 0) + dropped
            text = json.dumps(payload, separators=(",", ":"), default=str)
        if len(text) > REDFISH_MAX_CHARS:
            text = (text[:REDFISH_MAX_CHARS] + "\n...(truncated: use a named Redfish tool, a member path, or $top"
                    " for a smaller response)")
        return text

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

        if self.redfish_enabled:
            @self.mcp.tool(name="redfish_get")
            async def redfish_get_tool(hostname: str, path: str) -> str:
                """Read one allowlisted Redfish resource from a node's BMC with GET."""
                return await asyncio.to_thread(self.redfish_tool, self.redfish_get, hostname, path)

            @self.mcp.tool(name="redfish_system_summary")
            async def redfish_system_summary_tool(hostname: str) -> str:
                """Return BMC-reported power state, health, model, serial and BIOS version."""
                return await asyncio.to_thread(self.redfish_tool, self.redfish_system_summary, hostname)

            @self.mcp.tool(name="redfish_thermal")
            async def redfish_thermal_tool(hostname: str, chassis: str = "") -> str:
                """Summarize BMC temperature and fan sensors with thresholds and health."""
                return await asyncio.to_thread(self.redfish_tool, self.redfish_thermal, hostname, chassis)

            @self.mcp.tool(name="redfish_power")
            async def redfish_power_tool(hostname: str, chassis: str = "") -> str:
                """Return BMC-reported power draw and power supply status."""
                return await asyncio.to_thread(self.redfish_tool, self.redfish_power, hostname, chassis)

            @self.mcp.tool(name="redfish_sel")
            async def redfish_sel_tool(hostname: str, limit: int = 50) -> str:
                """Return the newest BMC manager and system log entries."""
                return await asyncio.to_thread(self.redfish_tool, self.redfish_sel, hostname, limit)

            @self.mcp.tool(name="redfish_firmware")
            async def redfish_firmware_tool(hostname: str) -> str:
                """Return the BMC firmware inventory."""
                return await asyncio.to_thread(self.redfish_tool, self.redfish_firmware, hostname)


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
