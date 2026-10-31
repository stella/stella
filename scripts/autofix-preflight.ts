import { readFileSync } from "node:fs";

import { safeAutofixRuleArgs } from "./autofix-safe-rules";

type PreflightChecks = {
  formatClean: (paths: readonly string[]) => boolean;
  lintClean: (paths: readonly string[]) => boolean;
};

type PreflightInput = {
  generatorSelected: boolean;
  formatPaths: readonly string[];
  lintPaths: readonly string[];
};

export const decideAutofixPreflight = (
  input: PreflightInput,
  checks: PreflightChecks,
): "run" | "skip" => {
  if (input.generatorSelected) {
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
  Bun.spawnSync([...command], { stdout: "inherit", stderr: "inherit" })
    .exitCode === 0;

if (import.meta.main) {
  const formatPaths = readNullSeparatedPaths(process.argv[2] ?? "");
  const lintPaths = readNullSeparatedPaths(process.argv[3] ?? "");
  const decision = decideAutofixPreflight(
    {
      generatorSelected: process.env["GENERATOR_SELECTED"] === "true",
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
          "bunx",
          "--bun",
          "oxlint@1.87.0",
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
