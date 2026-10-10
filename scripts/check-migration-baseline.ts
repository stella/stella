#!/usr/bin/env bun

// scripts/migration-baseline.txt shrinks, with one exception: a change that
// introduces a migration-safety rule may baseline migrations that were already
// merged, are unchanged, and are flagged by that new rule. Everything else an
// added entry could exempt is a migration the current rule set must lint.

import { panic } from "better-result";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { checkMigrationSources } from "./check-migration-safety";
import { MIGRATION_SAFETY_RULE_IDS } from "./migration-safety-rule-ids";

const BASELINE_FILE = "scripts/migration-baseline.txt";
const RULE_IDS_FILE = "scripts/migration-safety-rule-ids.ts";

type BaselineAdditionViolation =
  | { type: "not-merged"; entry: string }
  | { type: "changed"; entry: string }
  | { type: "no-base-rule-ids"; entry: string }
  | { type: "no-new-rule"; entry: string }
  | { type: "not-flagged-by-new-rule"; entry: string; newRuleIds: string[] };

type BaselineChange = {
  baseEntries: ReadonlySet<string>;
  headEntries: readonly string[];
  /** Files present at the merge base. */
  baseFiles: ReadonlySet<string>;
  /** Files that differ between the merge base and the checkout. */
  changedFiles: ReadonlySet<string>;
  /** Rule ids at the merge base; null when the base declares none. */
  baseRuleIds: readonly string[] | null;
  headRuleIds: readonly string[];
  /** Rule ids the head rule set reports for a migration. */
  flaggedRuleIds: (entry: string) => readonly string[];
};

export const parseBaselineEntries = (source: string): string[] =>
  source
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

export const findBaselineAdditionViolations = ({
  baseEntries,
  headEntries,
  baseFiles,
  changedFiles,
  baseRuleIds,
  headRuleIds,
  flaggedRuleIds,
}: BaselineChange): BaselineAdditionViolation[] => {
  const violations: BaselineAdditionViolation[] = [];
  const newRuleIds =
    baseRuleIds === null
      ? null
      : headRuleIds.filter((id) => !baseRuleIds.includes(id));

  for (const entry of headEntries) {
    if (baseEntries.has(entry)) {
      continue;
    }
    if (!baseFiles.has(entry)) {
      violations.push({ type: "not-merged", entry });
      continue;
    }
    if (changedFiles.has(entry)) {
      violations.push({ type: "changed", entry });
      continue;
    }
    if (newRuleIds === null) {
      violations.push({ type: "no-base-rule-ids", entry });
      continue;
    }
    if (newRuleIds.length === 0) {
      violations.push({ type: "no-new-rule", entry });
      continue;
    }
    const flagged = new Set(flaggedRuleIds(entry));
    if (!newRuleIds.some((id) => flagged.has(id))) {
      violations.push({ type: "not-flagged-by-new-rule", entry, newRuleIds });
    }
  }

  return violations;
};

export const describeBaselineAdditionViolation = (
  violation: BaselineAdditionViolation,
): string => {
  switch (violation.type) {
    case "not-merged":
      return `${violation.entry} is added to ${BASELINE_FILE} but is not a migration at the merge base; lint the new migration instead.`;
    case "changed":
      return `${violation.entry} is added to ${BASELINE_FILE} in the same change that modifies it; lint the modified migration instead.`;
    case "no-base-rule-ids":
      return `${violation.entry} is added to ${BASELINE_FILE}, but the merge base has no ${RULE_IDS_FILE} to show which rules this change introduces.`;
    case "no-new-rule":
      return `${violation.entry} is added to ${BASELINE_FILE}, but this change adds no rule to ${RULE_IDS_FILE}. The baseline only shrinks unless a change introduces a migration-safety rule.`;
    case "not-flagged-by-new-rule":
      return `${violation.entry} is added to ${BASELINE_FILE}, but none of the rules this change introduces (${violation.newRuleIds.join(", ")}) flags it.`;
    default:
      violation satisfies never;
      return panic("Unhandled baseline addition violation");
  }
};

const runGit = (arguments_: readonly string[]): string => {
  const result = Bun.spawnSync(["git", ...arguments_], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    panic(
      `git ${arguments_.join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
};

const lines = (output: string): string[] =>
  output.split("\n").filter((line) => line.length > 0);

const fileAt = (revision: string, file: string): string | null => {
  const result = Bun.spawnSync(["git", "show", `${revision}:${file}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString() : null;
};

// The base list is evaluated from a standalone copy; the file is import-free.
const readBaseRuleIds = async (
  revision: string,
): Promise<readonly string[] | null> => {
  const source = fileAt(revision, RULE_IDS_FILE);
  if (source === null) {
    return null;
  }
  const directory = mkdtempSync(path.join(tmpdir(), "migration-rule-ids-"));
  try {
    const file = path.join(directory, "migration-safety-rule-ids.ts");
    writeFileSync(file, source);
    const module: unknown = await import(file);
    const ids =
      module !== null && typeof module === "object"
        ? Reflect.get(module, "MIGRATION_SAFETY_RULE_IDS")
        : undefined;
    if (
      !Array.isArray(ids) ||
      !ids.every((id): id is string => typeof id === "string")
    ) {
      panic(
        `${RULE_IDS_FILE} at ${revision} does not export MIGRATION_SAFETY_RULE_IDS as a string list`,
      );
    }
    return ids;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const flaggedRuleIds = (entry: string): string[] => {
  const result = checkMigrationSources([
    { file: entry, source: readFileSync(entry, "utf-8") },
  ]).at(0);
  if (result === undefined) {
    panic(`No migration-safety result for ${entry}`);
  }
  return [...result.invariantFindings, ...result.guardedFindings].map(
    ({ ruleId }) => ruleId,
  );
};

const main = async () => {
  const baseRef = Bun.argv.at(2);
  if (baseRef === undefined) {
    panic("Usage: bun scripts/check-migration-baseline.ts <base-ref>");
  }
  const mergeBase = runGit(["merge-base", baseRef, "HEAD"]).trim();
  const headEntries = parseBaselineEntries(
    readFileSync(BASELINE_FILE, "utf-8"),
  );
  const baseEntries = new Set(
    parseBaselineEntries(fileAt(mergeBase, BASELINE_FILE) ?? ""),
  );
  if (headEntries.every((entry) => baseEntries.has(entry))) {
    return;
  }

  const violations = findBaselineAdditionViolations({
    baseEntries,
    headEntries,
    baseFiles: new Set(
      lines(runGit(["ls-tree", "-r", "--name-only", mergeBase])),
    ),
    // Against the working tree, so uncommitted edits count as changes.
    changedFiles: new Set(
      lines(runGit(["diff", "--no-renames", "--name-only", mergeBase])),
    ),
    baseRuleIds: await readBaseRuleIds(mergeBase),
    headRuleIds: MIGRATION_SAFETY_RULE_IDS,
    flaggedRuleIds,
  });

  for (const violation of violations) {
    console.error(`ERROR: ${describeBaselineAdditionViolation(violation)}`);
  }
  if (violations.length > 0) {
    process.exit(1);
  }
};

if (import.meta.main) {
  await main();
}
