// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export const metric = "DCGM_FI_DEV_GPU_UTIL";
export const end = Date.parse("2026-11-06T00:00:00Z") / 1000;
export const start = end - 8 * 86400;
export const interval = 60;
export const cases = [
  { id: "three-day-gap", host: "fixture-gpu-a", last: end - 3 * 86400 - 60, missing: end - 3 * 86400, value: 42, count: 7200 },
  { id: "history-unavailable", host: "fixture-gpu-b", last: null, missing: null, value: 42, count: 0 },
  { id: "healthy-zero", host: "fixture-gpu-c", last: end, missing: null, value: 0, count: 11521 },
  { id: "two-hour-gap", host: "fixture-gpu-d", last: end - 2 * 3600 - 60, missing: end - 2 * 3600, value: 23, count: 11400 },
];
export const replayCases = [...cases, { ...cases[0], id: "three-day-gap-followup", followup: true }];

// Ground truth belongs to the evaluator. Only host, metric, current time and
// independently known scrape cadence are supplied to the model.
export function userPrompt(scenario) {
  if (scenario.followup) return `请检查 ${scenario.host} 的 GPU 0 在最近两小时的 ${metric} 数据。`;
  if (scenario.id === "healthy-zero") return `请检查 ${scenario.host} 的 GPU 0，指标是 ${metric}。最近的值一直是 0，这是否说明采集已经中断了？请查数据回答，不要更改配置。`;
  return `请检查 ${scenario.host} 的 GPU 0 状态指标 ${metric}。最近图上没有数据了，请判断大约是从什么时候开始缺失的，并给出时间依据。不要更改配置。`;
}
