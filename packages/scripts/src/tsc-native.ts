#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import path from "node:path";

const tsc = path.join(
  import.meta.dir,
  "../../../node_modules/@typescript/native/bin/tsc",
);

const result = spawnSync(process.execPath, [tsc, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
}

process.exit(result.status ?? 1);
