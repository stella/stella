#!/usr/bin/env bun
// Fast file-scoped local typechecker for changed TypeScript files.
// Runs `bun check --no-pretty` on only the touched .ts/.tsx/.mts/.cts files
// (and their transitive imports), giving seconds-level feedback on `@stll/api`
// and other large workspaces without waiting for a full CI round-trip.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { childExitStatus } from "../packages/scripts/src/child-exit-status";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CHILD_MAX_BUFFER = 16 * 1024 * 1024;

const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

const isCheckableTypeScriptFile = (file: string): boolean => {
  if (
    file.endsWith(".d.ts") ||
    file.endsWith(".d.mts") ||
    file.endsWith(".d.cts")
  ) {
    return false;
  }
  return TS_EXTENSIONS.some((ext) => file.endsWith(ext));
};

/** Filter changed repo-relative paths down to checkable TypeScript source files. */
export const selectTypecheckFiles = (
  changedFiles: readonly string[],
  options: { readonly fileExists?: (repoRelPath: string) => boolean } = {},
): readonly string[] => {
  const checkExists =
    options.fileExists ??
    ((repoRelPath: string) => existsSync(path.resolve(REPO_ROOT, repoRelPath)));
  return [
    ...new Set(
      changedFiles.filter(
        (file) => isCheckableTypeScriptFile(file) && checkExists(file),
      ),
    ),
  ].toSorted();
};

const readChangedFiles = (baseRef: string): readonly string[] => {
  const mergeBase = execFileSync("git", ["merge-base", baseRef, "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: CHILD_MAX_BUFFER,
  }).trim();
  const committed = execFileSync(
    "git",
    ["diff", "--name-only", "-z", `${mergeBase}...HEAD`],
    { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: CHILD_MAX_BUFFER },
  );
  const working = execFileSync("git", ["diff", "--name-only", "-z", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
    maxBuffer: CHILD_MAX_BUFFER,
  });
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: REPO_ROOT, encoding: "utf-8", maxBuffer: CHILD_MAX_BUFFER },
  );
  return [committed, working, untracked]
    .flatMap((output) => output.split("\0"))
    .filter((entry) => entry.length > 0);
};

const parseArgs = (argv: readonly string[]) => {
  let baseRef = "origin/main";
  let listOnly = false;
  let timing = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--list") {
      listOnly = true;
    } else if (arg === "--timing") {
      timing = true;
    } else if (arg === "--base" && argv[i + 1] !== undefined) {
      baseRef = argv[i + 1] ?? baseRef;
      i++;
    }
  }
  return { baseRef, listOnly, timing };
};

if (import.meta.main) {
  const { baseRef, listOnly, timing } = parseArgs(process.argv.slice(2));
  const files = selectTypecheckFiles(readChangedFiles(baseRef));

  if (files.length === 0) {
    console.log("typecheck-changed: no changed TypeScript files to check.");
    process.exit(0);
  }

  if (listOnly) {
    for (const file of files) {
      console.log(file);
    }
    process.exit(0);
  }

  const args = [
    "check",
    "--no-pretty",
    ...(timing ? ["--timing"] : []),
    ...files,
  ];
  const result = spawnSync("bun", args, {
    cwd: REPO_ROOT,
    stdio: "inherit",
    maxBuffer: CHILD_MAX_BUFFER,
  });
  process.exit(childExitStatus(result));
}
