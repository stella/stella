import type {
  CourtWeightEntry,
  CourtWeightMap,
} from "@/api/handlers/case-law/court-weights";
import { arrayOrEmpty } from "@/api/lib/array";

/**
 * The court rank declaration every jurisdiction ships with. The migration
 * `case_law_court_weight_seed` inserts exactly these rows, so a deployed
 * database is never without them; `seed-court-weights.ts` re-upserts them
 * after an edit here, and `court-weight-seed.test.ts` holds the migration to
 * this list. Ranking code reads the table, never this constant.
 */

export type CourtWeightSeedRow = {
  country: string;
  courtPattern: string;
  tier: number;
  tierLabel: string;
  weight: number;
};

export const COURT_WEIGHT_SEED: readonly CourtWeightSeedRow[] = [
  // Czech Republic
  {
    country: "CZE",
    courtPattern: "ústavní soud",
    tier: 4,
    tierLabel: "constitutional",
    weight: 10,
  },
  {
    country: "CZE",
    courtPattern: "nejvyšší",
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  },
  {
    country: "CZE",
    courtPattern: "vrchní soud|krajský soud|městský soud",
    tier: 2,
    tierLabel: "regional",
    weight: 4,
  },
  // Slovakia
  {
    country: "SVK",
    courtPattern: "ústavný súd",
    tier: 4,
    tierLabel: "constitutional",
    weight: 10,
  },
  {
    country: "SVK",
    courtPattern: "najvyšší",
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  },
  {
    country: "SVK",
    courtPattern: "krajský súd",
    tier: 2,
    tierLabel: "regional",
    weight: 4,
  },
  // Poland
  {
    country: "POL",
    courtPattern: "trybunał konstytucyjny",
    tier: 4,
    tierLabel: "constitutional",
    weight: 10,
  },
  {
    country: "POL",
    courtPattern: "sąd najwyższy|naczelny sąd administracyjny",
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  },
  {
    country: "POL",
    courtPattern: "sąd apelacyjny|sąd okręgowy",
    tier: 2,
    tierLabel: "regional",
    weight: 4,
  },
  // Austria. The RIS feeds store the court as the publisher's abbreviation
  // (`OGH`, `VwGH`, `VfGH`) or as the full name with the abbreviation in
  // brackets, so both spellings are ranked. Anchors rather than `\b`: the
  // same pattern runs as a JavaScript RegExp and as a PostgreSQL `~*` ARE,
  // and the two do not agree on word-boundary escapes.
  {
    country: "AUT",
    courtPattern: "verfassungsgerichtshof|^vfgh$",
    tier: 4,
    tierLabel: "constitutional",
    weight: 10,
  },
  {
    country: "AUT",
    courtPattern: "oberster gerichtshof|verwaltungsgerichtshof|^ogh$|^vwgh$",
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  },
  {
    country: "AUT",
    courtPattern: "oberlandesgericht|landesgericht",
    tier: 2,
    tierLabel: "regional",
    weight: 4,
  },
  // European Union
  {
    country: "EU",
    courtPattern: "court of justice",
    tier: 4,
    tierLabel: "constitutional",
    weight: 10,
  },
  {
    country: "EU",
    courtPattern: "general court",
    tier: 3,
    tierLabel: "supreme",
    weight: 8,
  },
];

const compile = (row: CourtWeightSeedRow): CourtWeightEntry => ({
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
    entries.sort((a, b) => b.tier - a.tier);
  }
  return map;
};

/** Every seeded entry across jurisdictions, highest tier first. */
export const courtWeightEntriesFromSeed = (): CourtWeightEntry[] =>
  [...courtWeightMapFromSeed().values()]
    .flat()
    .toSorted((a, b) => b.tier - a.tier);

const sqlLiteral = (value: string): string => `'${value.replace(/'/gu, "''")}'`;

/**
 * The `INSERT` the seed migration carries, rendered from the list above so
 * the two cannot drift: the migration file is compared to this text.
 */
export const courtWeightSeedInsertSql = (): string => {
  const values = COURT_WEIGHT_SEED.map(
    (row) =>
      `  (${sqlLiteral(row.country)}, ${sqlLiteral(row.courtPattern)}, ${String(row.tier)}, ${sqlLiteral(row.tierLabel)}, ${String(row.weight)})`,
  ).join(",\n");
  // The arbiter is a unique index, not a named constraint, so the rows that
  // already exist are skipped by an anti-join rather than ON CONFLICT.
  return [
    'INSERT INTO "case_law_court_weights" ("id", "country", "court_pattern", "tier", "tier_label", "weight")',
    "SELECT gen_random_uuid(), v.country, v.court_pattern, v.tier, v.tier_label, v.weight",
    "FROM (VALUES",
    values,
    ') AS v ("country", "court_pattern", "tier", "tier_label", "weight")',
    "WHERE NOT EXISTS (",
    '  SELECT 1 FROM "case_law_court_weights" w',
    '  WHERE w."country" = v.country AND w."court_pattern" = v.court_pattern',
    ");",
  ].join("\n");
};
