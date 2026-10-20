// The processed-field backlog baseline only shrinks.
//
// `processed-field-backlog-baseline.json` lists the source/field pairs whose
// disposition is a debt (`not-extracted`, `unassessed`) or whose claim has no
// recording yet. `processed-field-inventory.test.ts` holds the inventory and
// the file to exact agreement; agreement alone would let a change add a debt
// to both in one diff. This compares the file against the base revision's:
// a pair the base did not list fails. The one exception is a source the
// base revision does not register at all: it may enter with debt it declares
// under `newSourceDeclarations`, owned and linked to the change that clears
// it, so an existing source can never grow its backlog.
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

/**
 * Debt a source added in this change enters with, declared beside the lists:
 * which pairs, who owns clearing them, and the change that will. Pairs are
 * written without the source (`skipped:not-extracted|court-paragraph-numbers`).
 */
export type NewSourceDeclaration = {
  readonly owner: string;
  readonly followUp: string;
  readonly pairs: readonly string[];
};

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isNewSourceDeclaration = (
  value: unknown,
): value is NewSourceDeclaration => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const pairs: unknown = Reflect.get(value, "pairs");
  return (
    nonEmptyString(Reflect.get(value, "owner")) &&
    nonEmptyString(Reflect.get(value, "followUp")) &&
    Array.isArray(pairs) &&
    pairs.every(nonEmptyString)
  );
};

/** The full pairs each new-source declaration admits, keyed by source. */
export const declaredNewSourcePairs = (
  baseline: unknown,
  where: string,
): ReadonlyMap<string, readonly string[]> => {
  const declared: unknown =
    typeof baseline === "object" && baseline !== null
      ? Reflect.get(baseline, "newSourceDeclarations")
      : undefined;
  if (declared === undefined) {
    return new Map();
  }
  if (typeof declared !== "object" || declared === null) {
    return panic(`${where}: newSourceDeclarations is not a map of sources`);
  }
  return new Map(
    Object.entries(declared).map(([source, declaration]) => {
      if (!isNewSourceDeclaration(declaration)) {
        return panic(
          `${where}: newSourceDeclarations.${source} needs owner, followUp and pairs`,
        );
      }
      return [
        source,
        declaration.pairs.map((pair) => {
          const [list, field] = pair.split("|");
          return list === undefined || field === undefined
            ? panic(`${where}: newSourceDeclarations.${source} pair ${pair}`)
            : `${list}|${source}|${field}`;
        }),
      ];
    }),
  );
};

/**
 * Grown pairs a new source declared. A source counts as new only when the
 * base revision registers no adapter under its key.
 */
export const admittedNewSourcePairs = ({
  grown,
  declared,
  isRegisteredAtBase,
}: {
  grown: readonly string[];
  declared: ReadonlyMap<string, readonly string[]>;
  isRegisteredAtBase: (source: string) => boolean;
}): string[] =>
  grown.filter((pair) => {
    const source = pair.split("|").at(1);
    return (
      source !== undefined &&
      !isRegisteredAtBase(source) &&
      (declared.get(source) ?? []).includes(pair)
    );
  });

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

const ADAPTER_KEYS_FILE =
  "apps/api/src/lib/legal-search/ingestion-constants.ts";

/** Whether the base revision registers an adapter under this key. */
const registeredAtBase =
  (base: string) =>
  (source: string): boolean => {
    const shown = git(["show", `${base}:${ADAPTER_KEYS_FILE}`]);
    if (shown.exitCode !== 0) {
      return panic(
        `processed-field-backlog-guard: cannot read ${base}:${ADAPTER_KEYS_FILE}`,
      );
    }
    return shown.stdout.toString().includes(`"${source}"`);
  };

const baseArgument = (): string => {
  const index = process.argv.indexOf("--base");
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value === undefined || value.length === 0 || value.startsWith("-")
    ? panic("processed-field-backlog-guard: --base needs a revision")
    : value;
};

const main = (): number => {
  const baseRevision = baseArgument();
  const basePairs = readBasePairs(baseRevision);
  if (basePairs === undefined) {
    console.log(
      "processed-field-backlog-guard: the base has no backlog file; comparing with the bootstrap backlog.",
    );
  }
  const base = referencePairs(basePairs);
  const baseline: unknown = JSON.parse(
    readFileSync(path.join(REPO_ROOT, PROCESSED_FIELD_BACKLOG_FILE), "utf-8"),
  );
  const current = backlogPairs(baseline, PROCESSED_FIELD_BACKLOG_FILE);
  const admitted = new Set(
    admittedNewSourcePairs({
      grown: grownPairs({ current, base }),
      declared: declaredNewSourcePairs(baseline, PROCESSED_FIELD_BACKLOG_FILE),
      isRegisteredAtBase: registeredAtBase(baseRevision),
    }),
  );
  for (const pair of admitted) {
    console.log(
      `processed-field-backlog-guard: ${pair} enters with a new source, as its declaration states.`,
    );
  }
  const grown = grownPairs({ current, base }).filter(
    (pair) => !admitted.has(pair),
  );
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
