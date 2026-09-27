import { panic } from "better-result";

import { US_COURTS, US_WRITABLE_COURT_IDS } from "@stll/api-contract/us-courts";
import type { UsCourtTier } from "@stll/api-contract/us-courts";

import { arrayOrEmpty } from "@/api/lib/array";
import {
  compareCourtWeightPrecedence,
  flattenCourtWeightEntries,
} from "@/api/lib/case-law/court-weights";
import type {
  CourtWeightEntry,
  CourtWeightMap,
} from "@/api/lib/case-law/court-weights";

/**
 * The court rank declaration every jurisdiction ships with. The
 * `case_law_court_weight_seed*` migrations, applied in order, leave exactly
 * these rows, so a deployed database is never without them;
 * `seed-court-weights.ts` re-upserts them after an edit here, and
 * `court-weight-seed.test.ts` holds each migration to its rendering. Ranking
 * code reads the table, never this constant.
 */

export type CourtWeightSeedRow = {
  country: string;
  courtPattern: string;
  tier: number;
  tierLabel: string;
  weight: number;
};

/**
 * The ranks a court can hold, declared once: a tier and its weight belong
 * to the label, not to the jurisdiction, so two countries cannot spell the
 * same rank with different numbers.
 */
const RANK = {
  constitutional: { tier: 4, tierLabel: "constitutional", weight: 10 },
  supreme: { tier: 3, tierLabel: "supreme", weight: 8 },
  regional: { tier: 2, tierLabel: "regional", weight: 4 },
  appeal: { tier: 2, tierLabel: "appeal", weight: 5 },
  "procurement-review": { tier: 1, tierLabel: "procurement-review", weight: 3 },
  district: { tier: 1, tierLabel: "district", weight: 2 },
  "administrative-labour": {
    tier: 1,
    tierLabel: "administrative-labour",
    weight: 3,
  },
  special: { tier: 1, tierLabel: "special", weight: 3 },
} as const satisfies Record<
  string,
  Pick<CourtWeightSeedRow, "tier" | "tierLabel" | "weight">
>;

/** The rank each United States directory tier is seeded at. */
const US_TIER_RANK = {
  supreme: RANK.supreme,
  appellate: RANK.appeal,
  trial: RANK.district,
  special: RANK.special,
} as const satisfies Record<UsCourtTier, (typeof RANK)[keyof typeof RANK]>;

/**
 * The widest pattern a seed row may carry: the registry's `court_pattern`
 * column is `varchar(512)`.
 */
export const COURT_PATTERN_MAX_LENGTH = 512;

/**
 * A court's canonical name as an anchored, case-folded pattern that means the
 * same text as a JavaScript `u`-flag RegExp and as a PostgreSQL ARE: every
 * metacharacter either runtime gives a meaning is escaped, and nothing else,
 * since the `u` flag rejects needless escapes.
 */
const exactCourtPattern = (name: string): string => {
  const pattern = `^${name.toLowerCase().replace(/[$()*+.?[\\\]^{|}]/gu, "\\$&")}$`;
  return pattern.length <= COURT_PATTERN_MAX_LENGTH
    ? pattern
    : panic(`court name too long for one pattern: ${name}`);
};

/**
 * The United States rows, rendered from the court directory: one exact,
 * anchored pattern per writable court (`US_WRITABLE_COURT_IDS`), at the rank
 * of its directory tier. Only a writable court's name can be stored, so the
 * rows grow with write enrollment rather than with the directory.
 */
const usCourtWeightRows = (): CourtWeightSeedRow[] =>
  US_COURTS.filter(({ id }) => US_WRITABLE_COURT_IDS.has(id)).map(
    ({ canonicalName, tier }) => ({
      country: "USA",
      courtPattern: exactCourtPattern(canonicalName),
      tier: US_TIER_RANK[tier].tier,
      tierLabel: US_TIER_RANK[tier].tierLabel,
      weight: US_TIER_RANK[tier].weight,
    }),
  );

export const COURT_WEIGHT_SEED: readonly CourtWeightSeedRow[] = [
  // Czech Republic
  {
    country: "CZE",
    courtPattern: "ústavní soud",
    ...RANK.constitutional,
  },
  {
    country: "CZE",
    courtPattern: "nejvyšší",
    ...RANK.supreme,
  },
  {
    country: "CZE",
    courtPattern: "vrchní soud|krajský soud|městský soud",
    ...RANK.regional,
  },
  // Slovakia
  {
    country: "SVK",
    courtPattern: "ústavný súd",
    ...RANK.constitutional,
  },
  {
    country: "SVK",
    courtPattern: "najvyšší",
    ...RANK.supreme,
  },
  {
    country: "SVK",
    courtPattern: "krajský súd",
    ...RANK.regional,
  },
  // Poland. The feeds store the full court name with its seat appended
  // ("Sąd Okręgowy w Warszawie", "Sąd Rejonowy dla Warszawy-Śródmieścia"),
  // so each rank is the court's name without the seat. Appeal and regional
  // share tier 2 and differ by weight, the way the tier scale allows one
  // instance to outrank another without adding a tier the search blend
  // would have to rescale. The voivodeship administrative courts sit with
  // appeal rather than with district: they are the administrative branch's
  // first instance, but what they review is an authority's decision, and the
  // only court above them is the supreme one already ranked above.
  {
    country: "POL",
    courtPattern: "trybunał konstytucyjny",
    ...RANK.constitutional,
  },
  {
    country: "POL",
    courtPattern: "sąd najwyższy|naczelny sąd administracyjny",
    ...RANK.supreme,
  },
  {
    country: "POL",
    courtPattern: "sąd apelacyjny|wojewódzki sąd administracyjny",
    ...RANK.appeal,
  },
  {
    country: "POL",
    courtPattern: "sąd okręgowy",
    ...RANK.regional,
  },
  {
    country: "POL",
    courtPattern: "krajowa izba odwoławcza",
    ...RANK["procurement-review"],
  },
  {
    country: "POL",
    courtPattern: "sąd rejonowy",
    ...RANK.district,
  },
  // Austria. The RIS feeds store the court as the publisher's abbreviation
  // (`OGH`, `VwGH`, `VfGH`) or as the full name with the abbreviation in
  // brackets, so both spellings are ranked. Anchors rather than `\b`: the
  // same pattern runs as a JavaScript RegExp and as a PostgreSQL `~*` ARE,
  // and the two do not agree on word-boundary escapes.
  {
    country: "AUT",
    courtPattern: "verfassungsgerichtshof|^vfgh$",
    ...RANK.constitutional,
  },
  {
    country: "AUT",
    courtPattern: "oberster gerichtshof|verwaltungsgerichtshof|^ogh$|^vwgh$",
    ...RANK.supreme,
  },
  {
    country: "AUT",
    courtPattern: "oberlandesgericht|landesgericht",
    ...RANK.regional,
  },
  // Hungary. Court names are a seat plus the kind of court ("Fővárosi
  // Törvényszék", "Debreceni Járásbíróság"), so each rank is the kind alone.
  // Two kinds are ranked under a retired name as well, because a decision
  // carries the name in force when it was handed down: Legfelsőbb Bíróság is
  // the Kúria before 2012, and megyei/fővárosi bíróság the törvényszék before
  // 2013. The közigazgatási és munkaügyi bíróságok sat from 2013 to 2020 and
  // rank between the törvényszék that absorbed them and the járásbíróság, in
  // the same tier as the district courts but above them by weight.
  {
    country: "HUN",
    courtPattern: "alkotmánybíróság",
    ...RANK.constitutional,
  },
  {
    country: "HUN",
    courtPattern: "kúria|legfelsőbb bíróság",
    ...RANK.supreme,
  },
  {
    country: "HUN",
    courtPattern: "ítélőtábla",
    ...RANK.appeal,
  },
  {
    country: "HUN",
    courtPattern: "törvényszék|megyei bíróság|fővárosi bíróság",
    ...RANK.regional,
  },
  {
    country: "HUN",
    courtPattern: "közigazgatási és munkaügyi bíróság",
    ...RANK["administrative-labour"],
  },
  {
    country: "HUN",
    courtPattern: "járásbíróság|kerületi bíróság|városi bíróság",
    ...RANK.district,
  },
  // European Union
  {
    country: "EU",
    courtPattern: "court of justice",
    ...RANK.constitutional,
  },
  {
    country: "EU",
    courtPattern: "general court",
    ...RANK.supreme,
  },
  // United States: the writable courts of the court directory
  // (`us-courts.ts`). No court of this jurisdiction holds the constitutional
  // rank.
  ...usCourtWeightRows(),
];

const compile = (row: CourtWeightSeedRow): CourtWeightEntry => ({
  country: row.country,
  pattern: new RegExp(row.courtPattern, "iu"),
  tier: row.tier,
  tierLabel: row.tierLabel,
  weight: row.weight,
});

/**
 * The seed as the loader would return it from a seeded table: entries per
 * country, highest tier first. For tests and tools that must rank exactly as
 * production does without a database.
 */
export const courtWeightMapFromSeed = (): CourtWeightMap => {
  const map: CourtWeightMap = new Map();
  for (const row of COURT_WEIGHT_SEED) {
    const entries = arrayOrEmpty(map.get(row.country));
    entries.push(compile(row));
    map.set(row.country, entries);
  }
  for (const entries of map.values()) {
    entries.sort(compareCourtWeightPrecedence);
  }
  return map;
};

/**
 * One jurisdiction's seeded entries, highest tier first. A jurisdiction the
 * seed does not declare is a programming error here, never an empty rank: a
 * caller handed no entries would exercise the unseeded path by accident.
 */
export const seededCourtWeightEntries = (
  country: string,
): readonly CourtWeightEntry[] =>
  courtWeightMapFromSeed().get(country) ??
  panic(`court weight seed declares no jurisdiction ${country}`);

/** Every seeded entry across jurisdictions, in precedence order. */
export const courtWeightEntriesFromSeed = (): CourtWeightEntry[] =>
  flattenCourtWeightEntries(courtWeightMapFromSeed());

const sqlLiteral = (value: string): string => `'${value.replace(/'/gu, "''")}'`;

const SEED_COLUMNS =
  '"country", "court_pattern", "tier", "tier_label", "weight"';

const seedValuesSql = (rows: readonly CourtWeightSeedRow[]): string =>
  [
    "(VALUES",
    rows
      .map(
        (row) =>
          `  (${sqlLiteral(row.country)}, ${sqlLiteral(row.courtPattern)}, ${String(row.tier)}, ${sqlLiteral(row.tierLabel)}, ${String(row.weight)})`,
      )
      .join(",\n"),
    `) AS v (${SEED_COLUMNS})`,
  ].join("\n");

/** Brings a row an older seed left at another rank to the declared one. */
const seedUpdateSql = (values: string): string =>
  [
    'UPDATE "case_law_court_weights" w',
    'SET "tier" = v.tier, "tier_label" = v.tier_label, "weight" = v.weight',
    `FROM ${values}`,
    'WHERE w."country" = v.country AND w."court_pattern" = v.court_pattern',
    '  AND (w."tier", w."tier_label", w."weight") IS DISTINCT FROM (v.tier, v.tier_label, v.weight);',
  ].join("\n");

/**
 * Adds the declared rows the table lacks. The arbiter is a unique index, not
 * a named constraint, so the rows that already exist are skipped by an
 * anti-join rather than ON CONFLICT.
 */
const seedInsertSql = (values: string, rowCount: number): string =>
  [
    `-- stella-migration-safety: reviewed insert-select - the source relation is a ${String(rowCount)}-row VALUES list, not a table, so the statement is bounded and instant; rollback deletes the same (country, court_pattern) keys`,
    `INSERT INTO "case_law_court_weights" ("id", ${SEED_COLUMNS})`,
    "SELECT gen_random_uuid(), v.country, v.court_pattern, v.tier, v.tier_label, v.weight",
    `FROM ${values}`,
    "WHERE NOT EXISTS (",
    '  SELECT 1 FROM "case_law_court_weights" w',
    '  WHERE w."country" = v.country AND w."court_pattern" = v.court_pattern',
    ");",
  ].join("\n");

/**
 * The statements a full seed migration carries, rendered from `rows` so the
 * two cannot drift: the migration file is compared to this text. The
 * declaration is the table's only writer, so a pattern it no longer carries
 * is dropped and a row an older seed left at another rank is brought to the
 * declared one before the missing rows are added. A superseded pattern left
 * behind would keep matching court names the declaration now ranks
 * elsewhere, and which of the two wins is a precedence accident. Every
 * statement reads the VALUES list, never a table.
 */
export const courtWeightSeedSql = (
  rows: readonly CourtWeightSeedRow[] = COURT_WEIGHT_SEED,
): string => {
  const values = seedValuesSql(rows);
  const remove = [
    `-- stella-migration-safety: reviewed delete-data - drops only the (country, court_pattern) keys the declaration above no longer carries, from an operator-seeded registry of ${String(rows.length)} rows; rollback re-runs the previous release's seed`,
    'DELETE FROM "case_law_court_weights" w',
    "WHERE NOT EXISTS (",
    `  SELECT 1 FROM ${values}`,
    '  WHERE v.country = w."country" AND v.court_pattern = w."court_pattern"',
    ");",
  ].join("\n");
  return [
    remove,
    seedUpdateSql(values),
    seedInsertSql(values, rows.length),
  ].join("\n--> statement-breakpoint\n");
};

/**
 * The statements one jurisdiction's own seed migration carries: that
 * jurisdiction's declared rows brought to their rank and added where missing,
 * and nothing else. There is no DELETE and no other jurisdiction's row in the
 * VALUES list, so applying it cannot drop, move or re-rank a court another
 * jurisdiction declares; reconciling the whole registry stays the full seed's
 * job.
 */
export const courtWeightJurisdictionSeedSql = (country: string): string => {
  const rows = COURT_WEIGHT_SEED.filter((row) => row.country === country);
  if (rows.length === 0) {
    return panic(`court weight seed declares no jurisdiction ${country}`);
  }
  const values = seedValuesSql(rows);
  return [seedUpdateSql(values), seedInsertSql(values, rows.length)].join(
    "\n--> statement-breakpoint\n",
  );
};
