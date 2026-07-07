// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { blocksAutomationTool } from "../automation-context.ts";

export default definePluginEntry({
  id: "automation-guard",
  name: "Automation Guard",
  description: "Keeps scheduled and event-triggered Mosaic sessions read-only.",
  register(api) {
    api.on("before_tool_call", (event, context) => {
      if (!blocksAutomationTool(event.toolName, context.sessionKey)) return;
      return {
        block: true,
        blockReason: "Automated Mosaic sessions are read-only. Mutation and generic execution tools are unavailable.",
      };
    });
  },
});
