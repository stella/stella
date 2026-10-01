// Existing swallowed-item handler budgets may only lose members.
import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

const LEDGER_REL = "scripts/swallowed-item-error-ledger.json";
const REPO_ROOT = path.resolve(import.meta.dir, "..");

type LedgerEntry = { id: string; reason: string };

const isReasonedEntry = (entry: unknown): entry is LedgerEntry =>
  typeof entry === "object" &&
  entry !== null &&
  "id" in entry &&
  typeof entry.id === "string" &&
  "reason" in entry &&
  typeof entry.reason === "string" &&
  entry.reason.trim().length > 0;

const parseLedger = (text: string, label: string): string[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || !parsed.every(isReasonedEntry)) {
    panic(`${label} must be a reasoned ledger`);
  }
  return parsed.map((entry) => entry.id);
};

// The base branch's copy of the ledger, or null when the base has none.
const readBaseLedger = (baseRef: string): string[] | null => {
  const result = Bun.spawnSync(["git", "show", `${baseRef}:${LEDGER_REL}`], {
    cwd: REPO_ROOT,
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString();
    if (/exists on disk, but not in|does not exist in/u.test(stderr)) {
      return null;
    }
    return panic(`git show ${baseRef}:${LEDGER_REL} failed: ${stderr}`);
  }
  return parseLedger(result.stdout.toString(), `${baseRef}:${LEDGER_REL}`);
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

const check = (baseRef: string): number => {
  const current = parseLedger(
    readFileSync(path.join(REPO_ROOT, LEDGER_REL), "utf-8"),
    LEDGER_REL,
  );
  const added = addedEntries(current, readBaseLedger(baseRef));
  if (added.length === 0) {
    console.log(
      `swallowed-item-error ledger: OK. ${current.length} entries, none new vs ${baseRef}.`,
    );
    return 0;
  }
  console.error(
    `swallowed-item-error ledger: ${added.length} entries are not in ${baseRef}. The ledger only shrinks; surface the item failure instead of listing a new handler:`,
  );
  for (const entry of added) {
    console.error(`  ${entry}`);
  }
  return 1;
};

const selfTest = (): number => {
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
    console.log("check-swallowed-item-error-ledger --self-test: PASS");
    return 0;
  }
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  return 1;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--self-test") {
    process.exit(selfTest());
  }
  const baseIndex = args.indexOf("--base");
  const baseRef = baseIndex === -1 ? "origin/main" : args[baseIndex + 1];
  if (baseRef === undefined || baseRef === "") {
    console.error("--base requires a ref");
    process.exit(2);
  }
  process.exit(check(baseRef));
}
