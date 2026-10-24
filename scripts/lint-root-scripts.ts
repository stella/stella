#!/usr/bin/env bun

import { panic } from "better-result";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";
import {
  rootScriptLintPaths,
  rootTypeAwareLintCommand,
} from "./root-script-lint";

const tracked = Bun.spawnSync(["git", "ls-files", "-z"]);
if (tracked.exitCode !== 0) {
  panic(`git ls-files failed: ${tracked.stderr.toString().trim()}`);
}
const files = rootScriptLintPaths(
  tracked.stdout.toString().split("\0").filter(Boolean),
);
if (files.length === 0) {
  panic("lint-root-scripts: no script files found; refusing to pass vacuously");
}

const generated = Bun.spawnSync([
  "bun",
  "scripts/ci-generated-sources.ts",
  "prepare",
]);
if (generated.exitCode !== 0) {
  process.exit(childExitStatus(generated));
}

const result = Bun.spawnSync(rootTypeAwareLintCommand(files), {
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(childExitStatus(result));
