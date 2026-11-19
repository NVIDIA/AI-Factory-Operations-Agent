// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Keep the optional bridge's behavioral checks in the repository's existing CI test glob.
import './teams_graph_channel/channel.test.mjs';
import './teams_graph_channel/format.test.mjs';
import './teams_graph_channel/reformat.test.mjs';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('Teams chat deployment generator preserves DM and group isolation', () => {
  execFileSync('python3', [fileURLToPath(new URL('./teams_graph_channel/test_prepare.py', import.meta.url))],
    {encoding:'utf8'});
});
