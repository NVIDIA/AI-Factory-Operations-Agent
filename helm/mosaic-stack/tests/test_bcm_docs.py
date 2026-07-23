# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

import importlib.util
import json
import unittest
from pathlib import Path
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "files/bcm-docs/download_bcm_docs.py"
SPEC = importlib.util.spec_from_file_location("download_bcm_docs", SCRIPT)
docs = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(docs)


class NmcDocsTest(unittest.TestCase):
    def test_builds_guide_from_preferred_search_index(self):
        base = f"{docs.NMC_BASE_URL}/systems-administration-guide"
        responses = {
            f"{base}/versions1.json": json.dumps([
                {"version": "2.2.0"},
                {"version": "2.3.1", "preferred": True},
            ]),
            f"{base}/2.3.1/searchindex.js": "const searchData = " + json.dumps({"data": [
                {"type": "function", "filename": "api.html", "display_name": "skip", "content": "skip"},
                {"type": "doc", "filename": "nodes/power.html", "display_name": "Power Nodes", "content": "Power cycle a managed node."},
            ]}) + ";",
        }
        with mock.patch.object(docs, "fetch_text", side_effect=responses.__getitem__):
            name, text = docs.nmc_guide("systems-administration-guide", "Systems Administration", "2026-07-23T00:00:00+00:00")

        self.assertEqual(name, "nmc-systems-administration-guide.md")
        self.assertIn("Guide version: 2.3.1", text)
        self.assertIn("## Power Nodes", text)
        self.assertIn(f"Source: {base}/2.3.1/nodes/power.html", text)
        self.assertIn("Power cycle a managed node.", text)
        self.assertNotIn("skip", text)

    def test_requires_one_preferred_version(self):
        with mock.patch.object(docs, "fetch_text", return_value='[{"version":"2.3.1"}]'):
            with self.assertRaises(RuntimeError) as error:
                docs.preferred_nmc_version("https://docs.example.test/guide")
        self.assertIn("expected one preferred NMC version", str(error.exception))


if __name__ == "__main__":
    unittest.main()
