// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { registerAlertAutomation } from "./plugin.ts";

export default definePluginEntry({
  id: "alert-automation",
  name: "Alert Automation",
  description:
    "Durable Alertmanager-triggered autonomous investigations and configurable native-channel delivery.",
  register: registerAlertAutomation,
});
