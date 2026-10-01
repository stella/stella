import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

type ReadBaseLedgerOptions = {
  baseRef: string;
  ledgerRel: string;
  repoRoot: string;
  parseLedger: (text: string, label: string) => string[];
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
};

export const runLedgerMembershipGuard = ({
  ledgerRel,
  repoRoot,
  parseLedger,
  label,
  remediation,
}: RunLedgerMembershipGuardOptions): number => {
  const args = process.argv.slice(2);
  if (args[0] === "--self-test") {
    return selfTestLedgerMembership(`check-${label}-ledger`);
  }
  const baseIndex = args.indexOf("--base");
  const baseRef = baseIndex === -1 ? "origin/main" : args[baseIndex + 1];
  if (baseRef === undefined || baseRef === "") {
    console.error("--base requires a ref");
    return 2;
  }

  const current = parseLedger(
    readFileSync(path.join(repoRoot, ledgerRel), "utf-8"),
    ledgerRel,
  );
  const added = addedEntries(
    current,
    readBaseLedger({ baseRef, ledgerRel, repoRoot, parseLedger }),
  );
  if (added.length === 0) {
    console.log(
      `${label} ledger: OK. ${current.length} entries, none new vs ${baseRef}.`,
    );
    return 0;
  }
  console.error(
    `${label} ledger: ${added.length} entries are not in ${baseRef}. The ledger only shrinks; ${remediation}:`,
  );
  for (const entry of added) {
    console.error(`  ${entry}`);
  }
  return 1;
};
