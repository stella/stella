#!/usr/bin/env bun
/**
 * Regenerates `packages/api-contract/src/us-reporter-editions.generated.ts`
 * and its notice, `us-reporters.LICENSE`, from the reporters database of the
 * Free Law Project.
 *
 * A reporter citation's identity is its canonical edition spelling, so the
 * table is an identity-format dependency: a different edition map can make a
 * stored citation stop matching the same citation typed later. The source is
 * therefore pinned to one commit, never to a branch.
 *
 * The upstream file keys each abbreviation to an ARRAY of reporter records
 * (one abbreviation can name two reporters), and every record carries its own
 * editions and its own variation map. Every record is read; none is chosen
 * over another. A spelling resolves the way the database defines it: an exact
 * edition name wins over a variation, and a spelling that names several
 * editions stays a candidate set.
 *
 * Modes:
 *   (default)   regenerate and compare with the committed files; exit 1 on drift
 *   --write     overwrite the committed files
 *
 * A manual upgrade tool, outside the build and outside CI: it fetches the
 * pinned upstream revision over the network.
 */

import { panic } from "better-result";
import path from "node:path";
import * as v from "valibot";

import {
  formattedLikeRepository,
  writeOrCheckArtifacts,
} from "./generated-artifacts";

const UPSTREAM_REPO = "freelawproject/reporters-db";
const UPSTREAM_COMMIT = "e095e6bf914ffd0a7b272f3764179cf3dbdf246c";
const UPSTREAM_RAW = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_COMMIT}`;

const REPO_ROOT = path.join(import.meta.dir, "..");
const OUTPUT_DIR = path.join(REPO_ROOT, "packages/api-contract/src");
const TABLE_PATH = path.join(OUTPUT_DIR, "us-reporter-editions.generated.ts");
const LICENSE_PATH = path.join(OUTPUT_DIR, "us-reporters.LICENSE");

/**
 * The upstream abbreviations whose editions the table carries: the national,
 * federal and regional reporters, the official reports of the larger state
 * systems, and the nominative reports that preceded the numbered official
 * series. Every record under each key is taken, with all of its editions.
 */
const SELECTED_REPORTERS = [
  "U.S.",
  "S. Ct.",
  "L. Ed.",
  "F.",
  "F. Supp.",
  "A.",
  "N.E.",
  "N.W.",
  "P.",
  "S.E.",
  "S.W.",
  "So.",
  "N.Y.",
  "Cal.",
  "Mass.",
  "Pa.",
  "Ill.",
  "Tex.",
  "Dall.",
  "Cranch",
  "Wheat.",
  "Pet.",
  "How.",
  "Black",
  "Wall.",
] as const;

const editionSchema = v.object({
  end: v.nullable(v.string()),
  start: v.nullable(v.string()),
});

const reporterSchema = v.object({
  editions: v.record(v.string(), editionSchema),
  name: v.string(),
  variations: v.optional(v.record(v.string(), v.string())),
});

const reportersSchema = v.record(v.string(), v.array(reporterSchema));

type UpstreamReporter = v.InferOutput<typeof reporterSchema>;

type EditionRecord = {
  readonly name: string;
  readonly start: number | null;
  readonly end: number | null;
};

const spellingKey = (spelling: string): string => spelling.replace(/\s+/gu, "");

const yearOf = (iso: string | null): number | null => {
  if (iso === null) {
    return null;
  }
  const year = /^(?<year>\d{4})-/u.exec(iso)?.groups?.["year"];
  return year === undefined
    ? panic(`Unreadable edition date: ${iso}`)
    : Number(year);
};

/** Code-unit order: independent of the machine's locale. */
const compareText = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

const fetchText = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) {
    return panic(`GET ${url} answered ${String(response.status)}`);
  }
  return await response.text();
};

/** Must match the parser's folding, which reads the same keys. */
const foldedKey = (key: string): string => key.toLocaleLowerCase("und");

/**
 * One reporter record publishing under one edition: the edition and the
 * record's position in that edition's list, or null for a reporter the table
 * does not carry.
 */
type Candidate = readonly [edition: string, record: number | null];

const candidateId = ([edition, record]: Candidate): string =>
  `${edition}\u0000${String(record)}`;

const addTo = (
  map: Map<string, Map<string, Candidate>>,
  key: string,
  candidate: Candidate,
): void => {
  const existing = map.get(key) ?? new Map<string, Candidate>();
  existing.set(candidateId(candidate), candidate);
  map.set(key, existing);
};

const compareCandidates = (left: Candidate, right: Candidate): number =>
  compareText(left[0], right[0]) || (left[1] ?? -1) - (right[1] ?? -1);

const compareRecords = (left: EditionRecord, right: EditionRecord): number =>
  compareText(left.name, right.name) ||
  (left.start ?? 0) - (right.start ?? 0) ||
  (left.end ?? 0) - (right.end ?? 0);

type Table = {
  readonly editions: ReadonlyMap<string, readonly EditionRecord[]>;
  readonly spellings: ReadonlyMap<string, readonly Candidate[]>;
  readonly foreignFolds: readonly string[];
};

const buildTable = (
  reporters: Readonly<Record<string, readonly UpstreamReporter[]>>,
): Table => {
  const selectedEditions = new Set<string>();
  for (const key of SELECTED_REPORTERS) {
    const records =
      reporters[key] ?? panic(`Pinned upstream data has no reporter ${key}`);
    for (const record of records) {
      for (const edition of Object.keys(record.editions)) {
        selectedEditions.add(edition);
      }
    }
  }
  const allRecords = Object.values(reporters).flat();

  // Every record publishing under a selected edition, wherever the database
  // files it, in a stable order that numbers them.
  const editionRecords = new Map<
    string,
    { record: UpstreamReporter; entry: EditionRecord }[]
  >();
  for (const record of allRecords) {
    for (const [edition, dates] of Object.entries(record.editions)) {
      if (selectedEditions.has(edition)) {
        const list = editionRecords.get(edition) ?? [];
        list.push({
          record,
          entry: {
            name: record.name,
            start: yearOf(dates.start),
            end: yearOf(dates.end),
          },
        });
        editionRecords.set(edition, list);
      }
    }
  }
  const sortedEditionRecords = new Map(
    [...editionRecords].map(([edition, list]) => {
      const sorted = list.toSorted((left, right) =>
        compareRecords(left.entry, right.entry),
      );
      for (const [index, item] of sorted.entries()) {
        const next = sorted[index + 1];
        if (
          next !== undefined &&
          compareRecords(item.entry, next.entry) === 0
        ) {
          panic(`Two indistinguishable records publish ${edition}`);
        }
      }
      return [edition, sorted] as const;
    }),
  );
  const candidateOf = (
    record: UpstreamReporter,
    edition: string,
  ): Candidate => {
    const index = sortedEditionRecords
      .get(edition)
      ?.findIndex((item) => item.record === record);
    return [edition, index === undefined || index < 0 ? null : index];
  };

  // Resolution runs over the whole database, not the selection: a spelling
  // that is an edition of a reporter outside the table must not be read as a
  // variation of one inside it. Each candidate is a reporter record, not an
  // edition spelling, so two reporters sharing a spelling stay two.
  const exactBySpelling = new Map<string, Map<string, Candidate>>();
  const variationBySpelling = new Map<string, Map<string, Candidate>>();
  for (const record of allRecords) {
    for (const edition of Object.keys(record.editions)) {
      addTo(
        exactBySpelling,
        spellingKey(edition),
        candidateOf(record, edition),
      );
    }
    for (const [variation, edition] of Object.entries(
      record.variations ?? {},
    )) {
      addTo(
        variationBySpelling,
        spellingKey(variation),
        candidateOf(record, edition),
      );
    }
  }
  const resolve = (key: string): readonly Candidate[] => [
    ...(
      exactBySpelling.get(key) ??
      variationBySpelling.get(key) ??
      new Map()
    ).values(),
  ];
  const inTable = (candidates: readonly Candidate[]): boolean =>
    candidates.some(([, record]) => record !== null);

  const spellings = new Map<string, readonly Candidate[]>();
  const foreignFolds = new Set<string>();
  for (const key of new Set([
    ...exactBySpelling.keys(),
    ...variationBySpelling.keys(),
  ])) {
    const candidates = resolve(key);
    if (inTable(candidates)) {
      spellings.set(key, candidates.toSorted(compareCandidates));
    } else {
      foreignFolds.add(foldedKey(key));
    }
  }
  const tableFolds = new Set([...spellings.keys()].map(foldedKey));

  return {
    editions: new Map(
      [...sortedEditionRecords]
        .map(
          ([edition, list]) =>
            [edition, list.map(({ entry }) => entry)] as const,
        )
        .toSorted(([left], [right]) => compareText(left, right)),
    ),
    spellings: new Map(
      [...spellings].toSorted(([left], [right]) => compareText(left, right)),
    ),
    foreignFolds: [...foreignFolds]
      .filter((fold) => tableFolds.has(fold))
      .toSorted(compareText),
  };
};

const renderTable = ({ editions, foreignFolds, spellings }: Table): string => {
  const lines = [
    "// Generated by scripts/generate-us-reporters.ts from",
    `// https://github.com/${UPSTREAM_REPO} at ${UPSTREAM_COMMIT}.`,
    "// Do not edit by hand. Derived data; see ./us-reporters.LICENSE.",
    "",
    "/** One reporter that publishes under an edition, and the years it covers. */",
    "export type UsReporterEditionRecord = {",
    "  readonly name: string;",
    "  readonly start: number | null;",
    "  /** Null while the edition is still being published. */",
    "  readonly end: number | null;",
    "};",
    "",
    "/**",
    " * Canonical edition spelling to every reporter that publishes under it. More",
    " * than one record means the edition spelling alone does not name the reporter.",
    " */",
    "export const US_REPORTER_EDITIONS: Readonly<",
    "  Record<string, readonly UsReporterEditionRecord[]>",
    "> = {",
    ...[...editions].map(
      ([edition, records]) =>
        `  ${JSON.stringify(edition)}: [${records
          .map(
            ({ end, name, start }) =>
              `{ name: ${JSON.stringify(name)}, start: ${String(start)}, end: ${String(end)} }`,
          )
          .join(", ")}],`,
    ),
    "};",
    "",
    "/**",
    " * A reporter record a spelling can name: its canonical edition and its",
    " * position in `US_REPORTER_EDITIONS[edition]`, or null for a reporter the",
    " * table does not carry.",
    " */",
    "export type UsReporterSpellingCandidate = readonly [",
    "  edition: string,",
    "  record: number | null,",
    "];",
    "",
    "/**",
    " * Every accepted spelling, whitespace removed, to the reporter records it",
    " * names. An exact edition name wins over a variation; more than one record",
    " * is a spelling the database leaves ambiguous.",
    " */",
    "export const US_REPORTER_SPELLINGS: Readonly<",
    "  Record<",
    "    string,",
    "    readonly [UsReporterSpellingCandidate, ...UsReporterSpellingCandidate[]]",
    "  >",
    "> = {",
    ...[...spellings].map(
      ([spelling, candidates]) =>
        `  ${JSON.stringify(spelling)}: [${candidates
          .map(
            ([edition, record]) =>
              `[${JSON.stringify(edition)}, ${String(record)}]`,
          )
          .join(", ")}],`,
    ),
    "};",
    "",
    "/**",
    " * Case-folded spellings that a reporter outside the table also answers to,",
    " * so a spelling typed in another case is not read as one inside it.",
    " */",
    "export const US_REPORTER_FOREIGN_FOLDED_SPELLINGS: readonly string[] = [",
    ...foreignFolds.map((fold) => `  ${JSON.stringify(fold)},`),
    "];",
    "",
  ];
  return lines.join("\n");
};

const renderLicense = (license: string): string =>
  [
    "The reporter edition table in us-reporter-editions.generated.ts is derived",
    `from reporters-db (https://github.com/${UPSTREAM_REPO}),`,
    `commit ${UPSTREAM_COMMIT}, which is distributed under the following`,
    "license:",
    "",
    license.trimEnd(),
    "",
  ].join("\n");

const main = async (): Promise<number> => {
  const write = process.argv.includes("--write");
  const [json, license] = await Promise.all([
    fetchText(`${UPSTREAM_RAW}/reporters_db/data/reporters.json`),
    fetchText(`${UPSTREAM_RAW}/LICENSE`),
  ]);
  const reporters = v.parse(reportersSchema, JSON.parse(json));
  const artifacts = [
    {
      path: TABLE_PATH,
      contents: await formattedLikeRepository(
        renderTable(buildTable(reporters)),
        "ts",
      ),
    },
    { path: LICENSE_PATH, contents: renderLicense(license) },
  ];

  return await writeOrCheckArtifacts(artifacts, {
    write,
    matched: UPSTREAM_COMMIT,
  });
};

process.exit(await main());
