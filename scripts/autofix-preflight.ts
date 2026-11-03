import { readFileSync } from "node:fs";

import { requiresTauriAlignment } from "./check-tauri-package-alignment";

// Decides, before the workspace install, whether the autofix pipeline can
// change anything, and fails closed: anything it cannot judge runs the full
// pipeline.
//
// A lint path always runs it. Whether the safe rules report a path needs the
// installed lint configuration, and whether a type-aware rule could report it
// is the type-aware precheck's question (scripts/autofix-type-aware-precheck.ts),
// which the fixer step asks after the install, before it prepares the type
// graph. Neither has a second answer here.

type PreflightChecks = {
  formatClean: (paths: readonly string[]) => boolean;
};

type PreflightInput = {
  generatorSelected: boolean;
  pruneRequested: boolean;
  fixPaths: readonly string[];
  formatPaths: readonly string[];
  lintPaths: readonly string[];
};

// Dependency manifests feed the Tauri counterpart alignment and the merged
// lockfile refresh, which formatting does not cover.
const manifestChanged = (paths: readonly string[]) =>
  requiresTauriAlignment(paths) ||
  paths.some(
    (file) => file === "package.json" || file.endsWith("/package.json"),
  );

export const decideAutofixPreflight = (
  input: PreflightInput,
  checks: PreflightChecks,
): "run" | "skip" => {
  if (
    input.generatorSelected ||
    input.pruneRequested ||
    input.lintPaths.length > 0 ||
    manifestChanged(input.fixPaths)
  ) {
    return "run";
  }
  try {
    return checks.formatClean(input.formatPaths) ? "skip" : "run";
  } catch {
    return "run";
  }
};

const readNullSeparatedPaths = (path: string) =>
  readFileSync(path)
    .toString("utf-8")
    .split("\0")
    .filter((entry) => entry.length > 0);

// Child output stays out of stdout, which the workflow appends to its outputs.
const commandSucceeds = (command: readonly string[]) =>
  Bun.spawnSync([...command], { stdout: "pipe", stderr: "inherit" })
    .exitCode === 0;

if (import.meta.main) {
  const [
    fixPathsFile = "",
    formatPathsFile = "",
    lintPathsFile = "",
    generatorSelected,
    pruneRequested,
  ] = process.argv.slice(2);
  const decision = decideAutofixPreflight(
    {
      generatorSelected: generatorSelected === "true",
      // Baseline pruning runs behind the preflight, so a requested prune
      // must keep the fix pipeline running even for clean files.
      pruneRequested: pruneRequested !== "false",
      fixPaths: readNullSeparatedPaths(fixPathsFile),
      formatPaths: readNullSeparatedPaths(formatPathsFile),
      lintPaths: readNullSeparatedPaths(lintPathsFile),
    },
    {
      formatClean: (paths) =>
        paths.length === 0 ||
        commandSucceeds([
          "bun",
          "fmt",
          "--check",
          "--ignore-unknown",
          ...paths,
        ]),
    },
  );
  console.log(`run=${decision === "run"}`);
}
