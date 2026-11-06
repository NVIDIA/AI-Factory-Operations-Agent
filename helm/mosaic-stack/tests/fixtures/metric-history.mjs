// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

// Print the complete synthetic fixture as OpenMetrics for promtool ingestion.
// No production endpoints, credentials, or scrape targets are used.
const end = Date.parse("2026-11-06T00:00:00Z") / 1000;
const start = end - 8 * 86400;
const cases = [
  ["fixture-gpu-a", end - 3 * 86400 - 60, 42],
  ["fixture-gpu-b", null, 42],
  ["fixture-gpu-c", end, 0],
  ["fixture-gpu-d", end - 2 * 3600 - 60, 23],
];
console.log("# HELP DCGM_FI_DEV_GPU_UTIL Synthetic GPU utilization for issue 103; not production data.");
console.log("# TYPE DCGM_FI_DEV_GPU_UTIL gauge");
for (const [host, last, value] of cases) {
  for (let time = start; last !== null && time <= last; time += 60) {
    console.log(`DCGM_FI_DEV_GPU_UTIL{Hostname="${host}",gpu="0"} ${value} ${time}`);
  }
}
console.log("# EOF");
