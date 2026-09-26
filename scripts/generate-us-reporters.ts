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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as v from "valibot";

const UPSTREAM_REPO = "freelawproject/reporters-db";
const UPSTREAM_COMMIT = "e095e6bf914ffd0a7b272f3764179cf3dbdf246c";
const UPSTREAM_RAW = `https://raw.githubusercontent.com/${UPSTREAM_REPO}/${UPSTREAM_COMMIT}`;

const REPO_ROOT = path.join(import.meta.dir, "..");
const OUTPUT_DIR = path.join(REPO_ROOT, "packages/api-contract/src");
const TABLE_PATH = path.join(OUTPUT_DIR, "us-reporter-editions.generated.ts");
const LICENSE_PATH = path.join(OUTPUT_DIR, "us-reporters.LICENSE");
const FORMATTER_CONFIG = path.join(REPO_ROOT, ".oxfmtrc.json");

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

const addTo = (
  map: Map<string, Set<string>>,
  key: string,
  value: string,
): void => {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, new Set([value]));
  } else {
    existing.add(value);
  }
};

type Table = {
  readonly editions: ReadonlyMap<string, readonly EditionRecord[]>;
  readonly spellings: ReadonlyMap<string, readonly string[]>;
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

  // Resolution runs over the whole database, not the selection: a spelling
  // that is an edition of a reporter outside the table must not be read as a
  // variation of one inside it.
  const editionRecords = new Map<string, EditionRecord[]>();
  const exactBySpelling = new Map<string, Set<string>>();
  const variationBySpelling = new Map<string, Set<string>>();
  for (const records of Object.values(reporters)) {
    for (const record of records) {
      for (const [edition, dates] of Object.entries(record.editions)) {
        addTo(exactBySpelling, spellingKey(edition), edition);
        if (selectedEditions.has(edition)) {
          const list = editionRecords.get(edition) ?? [];
          list.push({
            name: record.name,
            start: yearOf(dates.start),
            end: yearOf(dates.end),
          });
          editionRecords.set(edition, list);
        }
      }
      for (const [variation, edition] of Object.entries(
        record.variations ?? {},
      )) {
        addTo(variationBySpelling, spellingKey(variation), edition);
      }
    }
  }

  const spellings = new Map<string, readonly string[]>();
  const candidateKeys = new Set([
    ...[...selectedEditions].map(spellingKey),
    ...[...variationBySpelling]
      .filter(([, editions]) =>
        [...editions].some((edition) => selectedEditions.has(edition)),
      )
      .map(([key]) => key),
  ]);
  for (const key of candidateKeys) {
    const resolved = exactBySpelling.get(key) ?? variationBySpelling.get(key);
    const editions = [...(resolved ?? [])].toSorted(compareText);
    if (editions.some((edition) => selectedEditions.has(edition))) {
      spellings.set(key, editions);
    }
  }

  return {
    editions: new Map(
      [...editionRecords]
        .map(
          ([edition, records]) =>
            [
              edition,
              records.toSorted(
                (left, right) =>
                  compareText(left.name, right.name) ||
                  (left.start ?? 0) - (right.start ?? 0),
              ),
            ] as const,
        )
        .toSorted(([left], [right]) => compareText(left, right)),
    ),
    spellings: new Map(
      [...spellings].toSorted(([left], [right]) => compareText(left, right)),
    ),
  };
};

const renderTable = ({ editions, spellings }: Table): string => {
  const lines = [
    "// Generated by scripts/generate-us-reporters.ts from",
    `// https://github.com/${UPSTREAM_REPO} at ${UPSTREAM_COMMIT}.`,
    "// Do not edit by hand. Derived data; see ./us-reporters.LICENSE.",
    "",
    `export const US_REPORTERS_SOURCE_COMMIT = ${JSON.stringify(UPSTREAM_COMMIT)};`,
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
    " * Every accepted spelling, whitespace removed, to the canonical editions it",
    " * names. An exact edition name wins over a variation; more than one edition",
    " * is a spelling the database leaves ambiguous.",
    " */",
    "export const US_REPORTER_SPELLINGS: Readonly<",
    "  Record<string, readonly [string, ...string[]]>",
    "> = {",
    ...[...spellings].map(
      ([spelling, candidates]) =>
        `  ${JSON.stringify(spelling)}: [${candidates.map((candidate) => JSON.stringify(candidate)).join(", ")}],`,
    ),
    "};",
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

/** The committed table is formatted like every other source file. */
const formatted = async (source: string): Promise<string> => {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "us-reporters-"));
  try {
    const file = path.join(workDir, "table.ts");
    await writeFile(file, source, "utf-8");
    const result = Bun.spawnSync(
      [process.execPath, "--bun", "oxfmt", "-c", FORMATTER_CONFIG, file],
      { cwd: REPO_ROOT, stderr: "inherit", stdout: "inherit" },
    );
    if (result.exitCode !== 0) {
      return panic("oxfmt failed on the generated table");
    }
    return await readFile(file, "utf-8");
  } finally {
    await rm(workDir, { force: true, recursive: true });
  }
};

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
      contents: await formatted(renderTable(buildTable(reporters))),
    },
    { path: LICENSE_PATH, contents: renderLicense(license) },
  ];

  if (write) {
    await Promise.all(
      artifacts.map(
        async ({ contents, path: file }) =>
          await writeFile(file, contents, "utf-8"),
      ),
    );
    console.log(`wrote ${String(artifacts.length)} files`);
    return 0;
  }

  const drifted: string[] = [];
  for (const { contents, path: file } of artifacts) {
    const committed = await readFile(file, "utf-8").catch(() => null);
    if (committed !== contents) {
      drifted.push(path.relative(REPO_ROOT, file));
    }
  }
  for (const file of drifted) {
    console.error(`drifted: ${file}`);
  }
  if (drifted.length > 0) {
    console.error("Run with --write.");
    return 1;
  }
  console.log(`${String(artifacts.length)} files match ${UPSTREAM_COMMIT}`);
  return 0;
};

process.exit(await main());
