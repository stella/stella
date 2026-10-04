import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

type ReadBaseLedgerOptions = {
  baseRef: string;
  ledgerRel: string;
  repoRoot: string;
  parseLedger: (text: string, label: string) => string[];
};

type CompareLedgerMembershipOptions = ReadBaseLedgerOptions & {
  current: readonly string[];
};

type CompareLedgerMembershipResult =
  | { type: "unresolved-base" }
  | { type: "compared"; added: string[] };

const compareLedgerMembership = ({
  baseRef,
  current,
  ledgerRel,
  repoRoot,
  parseLedger,
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
  const commit = resolved.stdout.toString().trim();
  const base = readBaseLedger({
    baseRef: commit,
    ledgerRel,
    repoRoot,
    parseLedger,
  });
  return {
    type: "compared",
    added: addedEntries(current, base),
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
  });
  if (comparison.type === "unresolved-base") {
    error(
      `${label} ledger: base ${baseRef} could not be resolved; membership cannot be checked.`,
    );
    return 2;
  }
  const { added } = comparison;
  if (added.length === 0) {
    log(
      `${label} ledger: OK. ${current.length} entries, none new vs ${baseRef}.`,
    );
    return 0;
  }
  error(
    `${label} ledger: ${added.length} entries are not in ${baseRef}. The ledger only shrinks; ${remediation}:`,
  );
  for (const entry of added) {
    error(`  ${entry}`);
  }
  return 1;
};
