// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const sourceExtensions = new Set([
  ".c", ".cc", ".cjs", ".cpp", ".cu", ".cuh", ".h", ".hpp",
  ".js", ".jsx", ".mjs", ".py", ".sh", ".ts", ".tsx",
]);
const copyright = "SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.";
const license = "SPDX-License-Identifier: Apache-2.0";

test("tracked source files carry the approved NVIDIA SPDX header", () => {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((file) => sourceExtensions.has(extname(file)));
  const violations = files.flatMap((file) => {
    const header = readFileSync(file, "utf8").split("\n").slice(0, 12);
    const copyrightLine = header.findIndex((line) => line.includes(copyright));
    const licenseLine = header.findIndex((line) => line.includes(license));
    return copyrightLine >= 0 && licenseLine > copyrightLine ? [] : [file];
  });
  assert.deepEqual(violations, []);
});
