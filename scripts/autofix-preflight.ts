import { readFileSync } from "node:fs";

import { safeAutofixRuleArgs } from "./autofix-safe-rules";

type PreflightChecks = {
  formatClean: (paths: readonly string[]) => boolean;
  lintClean: (paths: readonly string[]) => boolean;
};

type PreflightInput = {
  generatorSelected: boolean;
  pruneRequested: boolean;
  toolReady: boolean;
  formatPaths: readonly string[];
  lintPaths: readonly string[];
};

export const decideAutofixPreflight = (
  input: PreflightInput,
  checks: PreflightChecks,
): "run" | "skip" => {
  if (input.generatorSelected || input.pruneRequested || !input.toolReady) {
    return "run";
  }
  try {
    if (!checks.formatClean(input.formatPaths)) {
      return "run";
    }
    if (input.lintPaths.length > 0 && !checks.lintClean(input.lintPaths)) {
      return "run";
    }
    return "skip";
  } catch {
    return "run";
  }
};

const readNullSeparatedPaths = (path: string) =>
  readFileSync(path)
    .toString("utf-8")
    .split("\0")
    .filter((entry) => entry.length > 0);

const commandSucceeds = (command: readonly string[]) =>
  Bun.spawnSync([...command], { stdout: "pipe", stderr: "inherit" })
    .exitCode === 0;

if (import.meta.main) {
  const formatPaths = readNullSeparatedPaths(process.argv[2] ?? "");
  const lintPaths = readNullSeparatedPaths(process.argv[3] ?? "");
  const decision = decideAutofixPreflight(
    {
      generatorSelected: process.argv[4] === "true",
      // Baseline pruning runs behind the preflight, so a requested prune
      // must keep the fix pipeline running even for clean files.
      pruneRequested: process.argv[7] !== "false",
      toolReady: process.argv[5] !== "false",
      formatPaths,
      lintPaths,
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
      lintClean: (paths) =>
        commandSucceeds([
          process.argv[6] || "./node_modules/.bin/oxlint",
          "-c",
          "oxlint.config.ts",
          "--no-error-on-unmatched-pattern",
          ...safeAutofixRuleArgs(),
          ...paths,
        ]),
    },
  );
  console.log(`run=${decision === "run"}`);
}
