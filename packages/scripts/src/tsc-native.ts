#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const tsc = join(
  import.meta.dir,
  "../../../node_modules/@typescript/native/bin/tsc",
);

const result = spawnSync(process.execPath, [tsc, ...process.argv.slice(2)], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
