#!/usr/bin/env bun

import { panic } from "better-result";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUTS = [
  "packages/cli/src/generated/route-map.ts",
  "packages/cli/src/generated/tool-annotations.ts",
] as const;

const generate = () => {
  const result = spawnSync(
    process.execPath,
    ["packages/cli/src/codegen.ts", "--runtime-only"],
    { cwd: REPO_ROOT, stdio: "inherit" },
  );
  if (result.error !== undefined || result.status !== 0) {
    panic(
      `CLI runtime generation failed: ${String(result.error?.message ?? result.status)}`,
    );
  }
  return OUTPUTS.map((file) => readFileSync(path.join(REPO_ROOT, file)));
};

const first = generate();
const second = generate();
for (const [index, bytes] of first.entries()) {
  const regenerated = second.at(index);
  if (regenerated === undefined || !bytes.equals(regenerated)) {
    panic(
      `CLI runtime generation is not deterministic: ${String(OUTPUTS.at(index))}`,
    );
  }
}
