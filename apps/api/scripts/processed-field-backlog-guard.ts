// The processed-field backlog baseline only shrinks.
//
// `processed-field-backlog-baseline.json` lists the source/field pairs whose
// disposition is a debt (`not-extracted`, `unassessed`) or whose claim has no
// recording yet. `processed-field-inventory.test.ts` holds the inventory and
// the file to exact agreement; agreement alone would let a change add a debt
// to both in one diff. This compares the file against the base revision's:
// a pair the base did not list fails.
//
//   bun apps/api/scripts/processed-field-backlog-guard.ts --base <rev>   CI gate

import { panic } from "better-result";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.join(import.meta.dir, "..", "..", "..");

export const PROCESSED_FIELD_BACKLOG_FILE =
  "apps/api/src/handlers/case-law/ingestion/adapters/processed-field-backlog-baseline.json";

type PairLists = Readonly<Record<string, readonly string[]>>;

const isPairLists = (value: unknown): value is PairLists =>
  typeof value === "object" &&
  value !== null &&
  Object.values(value).every(
    (fields) =>
      Array.isArray(fields) &&
      fields.every((field) => typeof field === "string"),
  );

const pairsOf = (prefix: string, lists: unknown, where: string): string[] =>
  isPairLists(lists)
    ? Object.entries(lists).flatMap(([source, fields]) =>
        fields.map((field) => `${prefix}|${source}|${field}`),
      )
    : panic(`${where}: ${prefix} is not a map of source to field names`);

/** Every listed pair, keyed by the list it is on. */
export const backlogPairs = (baseline: unknown, where: string): string[] => {
  if (typeof baseline !== "object" || baseline === null) {
    return panic(`${where}: not a JSON object`);
  }
  const skipped: unknown = Reflect.get(baseline, "skipped");
  if (typeof skipped !== "object" || skipped === null) {
    return panic(`${where}: no "skipped" lists`);
  }
  return [
    ...Object.entries(skipped).flatMap(([reason, lists]) =>
      pairsOf(`skipped:${reason}`, lists, where),
    ),
    ...pairsOf("unrecorded", Reflect.get(baseline, "unrecorded"), where),
  ].toSorted();
};

const AT_RIS = [
  "at-asylgh",
  "at-bks",
  "at-bvwg",
  "at-courts",
  "at-lvwg",
  "at-ubas",
  "at-umse",
  "at-uvs",
  "at-verg",
  "at-vfgh",
  "at-vwgh",
] as const;

const paragraphNumbers = (sources: readonly string[]) =>
  Object.fromEntries(
    sources.map((source) => [source, ["court-paragraph-numbers"]]),
  );

/**
 * The backlog the baseline was introduced with: what a base revision that
 * predates the file is compared against, so the change that introduces the
 * file cannot add a debt the review did not see written here. Fixed; never
 * edited after the file exists, because from then on the base revision's
 * file is the reference.
 */
export const BOOTSTRAP_BACKLOG = {
  skipped: {
    "not-extracted": paragraphNumbers(["pl-courts", "pl-nsa", "sk-courts"]),
    unassessed: paragraphNumbers([
      ...AT_RIS,
      "pl-kio",
      "pl-kis",
      "pl-ncourt",
      "pl-sn",
      "pl-uodo",
      "pl-uokik",
      "us-courtlistener",
    ]),
  },
  unrecorded: paragraphNumbers([
    ...AT_RIS,
    "pl-courts",
    "pl-kio",
    "pl-kis",
    "pl-ncourt",
    "pl-sn",
    "pl-uodo",
    "pl-uokik",
    "sk-courts",
    "us-courtlistener",
  ]),
} as const;

/** The reference pairs: the base revision's file, or the bootstrap list. */
export const referencePairs = (base: readonly string[] | undefined) =>
  base ?? backlogPairs(BOOTSTRAP_BACKLOG, "bootstrap backlog");

/** Pairs the current file lists that the base revision's did not. */
export const grownPairs = ({
  current,
  base,
}: {
  current: readonly string[];
  base: readonly string[];
}): string[] => {
  const known = new Set(base);
  return current.filter((pair) => !known.has(pair));
};

const git = (args: readonly string[]) =>
  Bun.spawnSync(["git", ...args], { cwd: REPO_ROOT, stderr: "ignore" });

/** The base revision's pairs; undefined when the base has no such file. */
const readBasePairs = (base: string): string[] | undefined => {
  if (git(["cat-file", "-e", `${base}^{commit}`]).exitCode !== 0) {
    return panic(`processed-field-backlog-guard: ${base} is not a commit`);
  }
  if (
    git(["cat-file", "-e", `${base}:${PROCESSED_FIELD_BACKLOG_FILE}`])
      .exitCode !== 0
  ) {
    return undefined;
  }
  const shown = git(["show", `${base}:${PROCESSED_FIELD_BACKLOG_FILE}`]);
  if (shown.exitCode !== 0) {
    return panic(`processed-field-backlog-guard: cannot read ${base}`);
  }
  return backlogPairs(JSON.parse(shown.stdout.toString()), base);
};

const baseArgument = (): string => {
  const index = process.argv.indexOf("--base");
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value === undefined || value.length === 0 || value.startsWith("-")
    ? panic("processed-field-backlog-guard: --base needs a revision")
    : value;
};

const main = (): number => {
  const basePairs = readBasePairs(baseArgument());
  if (basePairs === undefined) {
    console.log(
      "processed-field-backlog-guard: the base has no backlog file; comparing with the bootstrap backlog.",
    );
  }
  const base = referencePairs(basePairs);
  const current = backlogPairs(
    JSON.parse(
      readFileSync(path.join(REPO_ROOT, PROCESSED_FIELD_BACKLOG_FILE), "utf-8"),
    ),
    PROCESSED_FIELD_BACKLOG_FILE,
  );
  const grown = grownPairs({ current, base });
  if (grown.length === 0) {
    console.log(
      `processed-field-backlog-guard: ${String(current.length)} pairs, none new against the base.`,
    );
    return 0;
  }
  console.error(
    "processed-field-backlog-guard: the backlog only shrinks; these pairs are new. Extract the field, assess the source, or record evidence instead:",
  );
  for (const pair of grown) {
    console.error(`  ${pair}`);
  }
  return 1;
};

if (import.meta.main) {
  process.exit(main());
}
