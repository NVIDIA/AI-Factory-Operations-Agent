# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import ipaddress
import json
import subprocess
import unittest
from pathlib import Path

import yaml


CHART = Path(__file__).parents[1]
SETTINGS = {
    "bcmMcp.mode": "external",
    "bcmMcp.authTokenCreate": "false",
    "diagnosticAgent.hostSshKeySecretName": "",
    "bcmMcp.mcpUrl": "https://bcm.example.test:3002/mcp",
    "bcmMcp.networkPolicy.enabled": "true",
    "bcmMcp.networkPolicy.headCidrs[0]": "192.0.2.10/32",
    "bcmMcp.networkPolicy.headCidrs[1]": "2001:db8::10/128",
}


def render(**changes):
    command = ["helm", "template", "trial", str(CHART), "--namespace", "trial"]
    for name, value in (SETTINGS | changes).items():
        command.extend(["--set", f"{name}={value}"])
    return subprocess.run(command, capture_output=True, text=True)


class ExternalBCMTests(unittest.TestCase):
    def test_external_auth_and_all_existing_tools_without_head_key_mounts(self):
        output = render(**{
            "modules.bcm.redfish.enabled": "true",
            "modules.diagnostics.enabled": "true",
            "modules.edit.enabled": "true",
            "modules.edit.bcm.enabled": "true",
            "bcmMcp.caCertificateSecret": "bcm-ca",
            "llm.mode": "external",
            "llm.external.baseUrl": "https://llm.example.test/v1",
            "llm.external.model": "example",
            "llm.external.caCertificateSecret": "llm-ca",
        })
        self.assertEqual(output.returncode, 0, output.stderr)
        objects = list(yaml.safe_load_all(output.stdout))
        deployments = {o["metadata"]["name"]: o for o in objects if o and o["kind"] == "Deployment"}
        self.assertNotIn("bcm-mcp-tools", deployments)
        runtime = deployments["openclaw"]["spec"]["template"]["spec"]
        env = {v["name"]: v for v in runtime["containers"][0]["env"]}
        self.assertEqual(env["MOSAIC_BCM_MCP_TOKEN"]["valueFrom"]["secretKeyRef"],
                         {"name": "bcm-mcp-auth", "key": "BCM_MCP_TOKEN"})
        self.assertEqual(env["NODE_EXTRA_CA_CERTS"]["value"], "/etc/combined-ca/ca.crt")
        ca_init = next(c for c in runtime["initContainers"] if c["name"] == "prepare-bcm-ca")
        self.assertEqual({m["name"] for m in ca_init["volumeMounts"]}, {"bcm-ca", "llm-ca", "combined-ca"})
        hardware = deployments["diagnostic-agent"]["spec"]["template"]["spec"]
        hardware_env = {v["name"]: v for v in hardware["containers"][0]["env"]}
        self.assertEqual(hardware_env["BCM_WEBHOOK_URL"]["value"], "https://bcm.example.test:3002")
        self.assertNotIn("NVDEBUG_HOST_SSH_KEY_PATH", hardware_env)
        for pod in (runtime, hardware):
            self.assertNotIn("bcm-host-ssh-key", {v.get("secret", {}).get("secretName") for v in pod["volumes"]})
        seed = next(o for o in objects if o and o["kind"] == "ConfigMap" and o["metadata"]["name"] == "openclaw-seed")
        config = json.loads(seed["data"]["openclaw.json"])["plugins"]["entries"]["bcm"]
        self.assertTrue(config["enabled"])
        for name in ("cmshEnabled", "editEnabled", "slurmEnabled", "redfishEnabled"):
            self.assertTrue(config["config"][name], name)
        self.assertEqual(config["config"]["authToken"], "${MOSAIC_BCM_MCP_TOKEN}")

    def test_direct_hardware_collection_has_no_manager_or_head_key_dependency(self):
        output = render(**{
            "modules.diagnostics.enabled": "true",
            "modules.bcm.enabled": "false",
            "diagnosticAgent.config.bcmLookupEnabled": "false",
            "bcmMcp.networkPolicy.enabled": "false",
        })
        self.assertEqual(output.returncode, 0, output.stderr)
        objects = [o for o in yaml.safe_load_all(output.stdout) if o]
        deployments = {o["metadata"]["name"]: o for o in objects if o["kind"] == "Deployment"}
        self.assertNotIn("bcm-mcp-tools", deployments)
        seed = next(o for o in objects if o["kind"] == "ConfigMap" and o["metadata"]["name"] == "openclaw-seed")
        plugins = json.loads(seed["data"]["openclaw.json"])["plugins"]["entries"]
        self.assertTrue(plugins["hardware-agent"]["enabled"])
        self.assertFalse(plugins["bcm"]["enabled"])
        pod = deployments["diagnostic-agent"]["spec"]["template"]["spec"]
        env = {e["name"] for e in pod["containers"][0]["env"]}
        self.assertFalse(any(name.startswith("BCM_WEBHOOK_") for name in env))
        self.assertIn("AGENT_API_KEYS", env)
        self.assertFalse(any(v.get("secret", {}).get("secretName") in {"bcm-ca", "bcm-host-ssh-key"} for v in pod["volumes"]))
        self.assertNotIn("prepare-bcm-ca", {i["name"] for i in pod["initContainers"]})

    def test_direct_hardware_credentials_preserve_independent_manager_tools(self):
        output = render(**{
            "modules.diagnostics.enabled": "true",
            "diagnosticAgent.config.bcmLookupEnabled": "false",
        })
        self.assertEqual(output.returncode, 0, output.stderr)
        objects = [o for o in yaml.safe_load_all(output.stdout) if o]
        seed = next(o for o in objects if o["kind"] == "ConfigMap" and o["metadata"]["name"] == "openclaw-seed")
        self.assertTrue(json.loads(seed["data"]["openclaw.json"])["plugins"]["entries"]["bcm"]["enabled"])

    def test_policy_allows_mcp_and_preserves_other_destinations(self):
        output = render()
        self.assertEqual(output.returncode, 0, output.stderr)
        policy = next(o["spec"] for o in yaml.safe_load_all(output.stdout) if o and o["kind"] == "NetworkPolicy" and o["metadata"]["name"] == "bcm-head-access")
        self.assertEqual(policy["podSelector"], {})

        def allowed(address, port):
            address = ipaddress.ip_address(address)
            for rule in policy["egress"]:
                if rule.get("ports") and not any(p["port"] == port for p in rule["ports"]):
                    continue
                for peer in rule["to"]:
                    block = peer["ipBlock"]
                    if address in ipaddress.ip_network(block["cidr"]) and not any(address in ipaddress.ip_network(c) for c in block.get("except", [])):
                        return True
            return False

        for address in ("192.0.2.10", "2001:db8::10"):
            self.assertTrue(allowed(address, 3002))
            for port in (22, 80, 443, 8081, 2222):
                self.assertFalse(allowed(address, port), (address, port))
        for address in ("192.0.2.20", "2001:db8::20", "10.96.0.10"):
            for port in (22, 53, 443, 6443):
                self.assertTrue(allowed(address, port), (address, port))

    def test_retains_optional_compute_node_ssh_credentials(self):
        output = render(**{"modules.diagnostics.enabled": "true", "diagnosticAgent.hostSshKeySecretName": "compute-node-key"})
        self.assertEqual(output.returncode, 0, output.stderr)
        hardware = next(o for o in yaml.safe_load_all(output.stdout) if o and o["kind"] == "Deployment" and o["metadata"]["name"] == "diagnostic-agent")
        volumes = hardware["spec"]["template"]["spec"]["volumes"]
        self.assertIn("compute-node-key", {v.get("secret", {}).get("secretName") for v in volumes})

    def test_rejects_inconsistent_external_configuration(self):
        for changes in (
            {"bcmMcp.enabled": "true"},
            {"bcmMcp.mcpUrl": "http://bcm.example.test:3002/mcp"},
            {"bcmMcp.hostSshKeySecretName": "root-key"},
            {"bcmMcp.authTokenCreate": "true"},
            {"bcmMcp.authTokenSecretName": ""},
            {"bcmMcp.networkPolicy.mcpPort": "22"},
            {"bcmMcp.networkPolicy.mcpPort": "443"},
        ):
            with self.subTest(changes=changes):
                self.assertNotEqual(render(**changes).returncode, 0)


if __name__ == "__main__":
    unittest.main()
