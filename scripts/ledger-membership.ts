import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

type ReadBaseLedgerOptions = {
  baseRef: string;
  ledgerRel: string;
  repoRoot: string;
  parseLedger: (text: string, label: string) => string[];
  normalizeBaseEntries?:
    | ((entries: string[], baseCommit: string) => string[])
    | undefined;
};

type CompareLedgerMembershipOptions = ReadBaseLedgerOptions & {
  current: readonly string[];
};

type CompareLedgerMembershipResult =
  | { type: "unresolved-base" }
  | { type: "compared"; added: string[]; comparedCommit: string };

/**
 * The commit a ledger is compared with: where HEAD forked from the base.
 * Comparing with the base tip instead counts every entry the base removed
 * after the fork as one this change added, so a re-run or an older merge
 * checkout goes red when the base shrinks its ledger. Without shared
 * history (an unborn HEAD or a shallow clone) the base tip itself is used:
 * stricter, never more lenient.
 */
const forkPoint = (repoRoot: string, baseCommit: string): string => {
  const result = Bun.spawnSync(
    ["git", "merge-base", "--end-of-options", "HEAD", baseCommit],
    { cwd: repoRoot, stderr: "pipe" },
  );
  const mergeBase = result.stdout.toString().trim();
  return result.exitCode === 0 && mergeBase !== "" ? mergeBase : baseCommit;
};

const compareLedgerMembership = ({
  baseRef,
  current,
  ledgerRel,
  repoRoot,
  parseLedger,
  normalizeBaseEntries,
}: CompareLedgerMembershipOptions): CompareLedgerMembershipResult => {
  const resolved = Bun.spawnSync(
    [
      "git",
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${baseRef}^{commit}`,
    ],
    { cwd: repoRoot, stderr: "pipe" },
  );
  if (resolved.exitCode !== 0) {
    return { type: "unresolved-base" };
  }
  const commit = forkPoint(repoRoot, resolved.stdout.toString().trim());
  const base = readBaseLedger({
    baseRef: commit,
    ledgerRel,
    repoRoot,
    parseLedger,
  });
  return {
    type: "compared",
    added: addedEntries(
      current,
      base === null ? null : (normalizeBaseEntries?.(base, commit) ?? base),
    ),
    comparedCommit: commit,
  };
};

const readBaseLedger = ({
  baseRef,
  ledgerRel,
  repoRoot,
  parseLedger,
}: ReadBaseLedgerOptions): string[] | null => {
  const result = Bun.spawnSync(["git", "show", `${baseRef}:${ledgerRel}`], {
    cwd: repoRoot,
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    if (/exists on disk, but not in|does not exist in/u.test(stderr)) {
      return null;
    }
    return panic(`git show ${baseRef}:${ledgerRel} failed: ${stderr}`);
  }
  return parseLedger(result.stdout.toString(), `${baseRef}:${ledgerRel}`);
};

const isReasonedEntry = (
  entry: unknown,
): entry is { id: string; reason: string } =>
  typeof entry === "object" &&
  entry !== null &&
  "id" in entry &&
  typeof entry.id === "string" &&
  "reason" in entry &&
  typeof entry.reason === "string" &&
  entry.reason.trim().length > 0;

/** The ids of a `[{ id, reason }]` ledger whose every reason is non-blank. */
export const parseReasonedLedger = (text: string, label: string): string[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every(isReasonedEntry)) {
    panic(`${label} must be a reasoned ledger`);
  }
  return parsed.map((entry) => entry.id);
};

export const addedEntries = (
  current: readonly string[],
  base: readonly string[] | null,
): string[] => {
  if (base === null) {
    return [];
  }
  const known = new Set(base);
  return current.filter((entry) => !known.has(entry));
};

const selfTestLedgerMembership = (label: string): number => {
  const failures: string[] = [];
  if (addedEntries(["a::x"], null).length !== 0) {
    failures.push("a base without a ledger must accept every entry");
  }
  if (addedEntries(["a::x"], ["a::x", "b::y"]).length !== 0) {
    failures.push("a shrunk ledger must pass");
  }
  const swapped = addedEntries(["a::x", "c::z"], ["a::x", "b::y"]);
  if (swapped.length !== 1 || swapped[0] !== "c::z") {
    failures.push("a swapped entry must be reported");
  }
  if (failures.length === 0) {
    console.log(`${label} --self-test: PASS`);
    return 0;
  }
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  return 1;
};

type RunLedgerMembershipGuardOptions = {
  ledgerRel: string;
  repoRoot: string;
  parseLedger: (text: string, label: string) => string[];
  normalizeBaseEntries?: ReadBaseLedgerOptions["normalizeBaseEntries"];
  label: string;
  remediation: string;
  args?: readonly string[];
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export const runLedgerMembershipGuard = ({
  ledgerRel,
  repoRoot,
  parseLedger,
  normalizeBaseEntries,
  label,
  remediation,
  args = process.argv.slice(2),
  log = console.log,
  error = console.error,
}: RunLedgerMembershipGuardOptions): number => {
  if (args[0] === "--self-test") {
    return selfTestLedgerMembership(`check-${label}-ledger`);
  }
  const baseIndex = args.indexOf("--base");
  const baseRef = baseIndex === -1 ? "origin/main" : args[baseIndex + 1];
  if (baseRef === undefined || baseRef === "") {
    error("--base requires a ref");
    return 2;
  }

  const current = parseLedger(
    readFileSync(path.join(repoRoot, ledgerRel), "utf-8"),
    ledgerRel,
  );
  const comparison = compareLedgerMembership({
    baseRef,
    current,
    ledgerRel,
    repoRoot,
    parseLedger,
    normalizeBaseEntries,
  });
  if (comparison.type === "unresolved-base") {
    error(
      `${label} ledger: base ${baseRef} could not be resolved; membership cannot be checked.`,
    );
    return 2;
  }
  const { added, comparedCommit } = comparison;
  const compared = `${baseRef} (fork point ${comparedCommit.slice(0, 12)})`;
  if (added.length === 0) {
    log(
      `${label} ledger: OK. ${current.length} entries, none new vs ${compared}.`,
    );
    return 0;
  }
  error(
    `${label} ledger: ${added.length} entries are not in ${compared}. The ledger only shrinks; ${remediation}:`,
  );
  for (const entry of added) {
    error(`  ${entry}`);
  }
  return 1;
};
