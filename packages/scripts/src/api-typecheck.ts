#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import path from "node:path";

import { childExitStatus } from "./child-exit-status";

// Turbo owns each project's dependency ordering and cache. Direct package
// invocations enter the same graph; its aggregate task has no compiler work.
if (!process.env["TURBO_HASH"]) {
  const result = spawnSync(
    process.execPath,
    ["run", "typecheck", "--filter=@stll/api"],
    { cwd: path.resolve(import.meta.dir, "../../.."), stdio: "inherit" },
  );
  process.exit(childExitStatus(result));
}
