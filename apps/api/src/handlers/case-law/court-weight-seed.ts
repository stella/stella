import { panic } from "better-result";

import {
  type CaseLawJurisdiction,
  isCaseLawJurisdiction,
} from "@stll/api-contract/case-law-jurisdictions";

import { arrayOrEmpty } from "@/api/lib/array";
import { type CourtRank, RANK } from "@/api/lib/case-law/court-ranks";
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
  country: CaseLawJurisdiction;
  courtPattern: string;
} & CourtRank;

/** A seeded row inside its jurisdiction's entry, which supplies the country. */
type CourtWeightSeedPattern = Omit<CourtWeightSeedRow, "country">;

/**
 * What a jurisdiction declares about ranking by court name. `ranked-by-name`
 * seeds the rows its decisions rank by; `ranked-by-court-id` ranks by the
 * court directory and keeps only rows an earlier seed migration wrote.
 */
type CourtWeightSeedDisposition =
  | { type: "ranked-by-name"; rows: readonly CourtWeightSeedPattern[] }
  | {
      type: "ranked-by-court-id";
      legacyRows: readonly CourtWeightSeedPattern[];
    };

/**
 * Every jurisdiction's court-name ranking decision. Total over
 * `CaseLawJurisdiction`, so a jurisdiction cannot be registered without one.
 * Entry order is the flat seed's order, which the seed migrations render.
 */
const COURT_WEIGHT_SEED_BY_JURISDICTION = {
  CZE: {
    type: "ranked-by-name",
    rows: [
      {
        courtPattern: "ústavní soud",
        ...RANK.constitutional,
      },
      {
        courtPattern: "nejvyšší",
        ...RANK.supreme,
      },
      {
        courtPattern: "vrchní soud|krajský soud|městský soud",
        ...RANK.regional,
      },
    ],
  },
  // Slovakia. PostgreSQL \s excludes NBSP; include it explicitly for parity
  // with JavaScript whitespace matching on publisher-stated court names.
  SVK: {
    type: "ranked-by-name",
    rows: [
      {
        courtPattern: "ústavný súd",
        ...RANK.constitutional,
      },
      {
        courtPattern: "najvyšší[\\s\u00a0]+súd",
        ...RANK.supreme,
      },
      {
        courtPattern: "najvyšší[\\s\u00a0]+správny[\\s\u00a0]+súd",
        ...RANK.supreme,
      },
      {
        courtPattern: "krajský súd",
        ...RANK.regional,
      },
      {
        courtPattern: "okresný súd|mestský súd",
        ...RANK.district,
      },
      {
        courtPattern: "špecializovaný trestný súd|špeciálny súd",
        ...RANK.special,
      },
      {
        courtPattern: "^správny súd",
        ...RANK.administrative,
      },
    ],
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
  POL: {
    type: "ranked-by-name",
    rows: [
      {
        courtPattern: "trybunał konstytucyjny",
        ...RANK.constitutional,
      },
      {
        courtPattern: "sąd najwyższy|naczelny sąd administracyjny",
        ...RANK.supreme,
      },
      {
        courtPattern: "sąd apelacyjny|wojewódzki sąd administracyjny",
        ...RANK.appeal,
      },
      {
        courtPattern: "sąd okręgowy",
        ...RANK.regional,
      },
      {
        courtPattern: "krajowa izba odwoławcza",
        ...RANK["procurement-review"],
      },
      {
        courtPattern: "sąd rejonowy",
        ...RANK.district,
      },
    ],
  },
  // Austria. The RIS feeds store the court as the publisher's abbreviation
  // (`OGH`, `VwGH`, `VfGH`) or as the full name with the abbreviation in
  // brackets, so both spellings are ranked. Anchors rather than `\b`: the
  // same pattern runs as a JavaScript RegExp and as a PostgreSQL `~*` ARE,
  // and the two do not agree on word-boundary escapes.
  AUT: {
    type: "ranked-by-name",
    rows: [
      {
        courtPattern: "verfassungsgerichtshof|^vfgh$",
        ...RANK.constitutional,
      },
      {
        courtPattern:
          "oberster gerichtshof|verwaltungsgerichtshof|^ogh$|^vwgh$",
        ...RANK.supreme,
      },
      {
        courtPattern: "oberlandesgericht|landesgericht",
        ...RANK.regional,
      },
    ],
  },
  // Hungary. Court names are a seat plus the kind of court ("Fővárosi
  // Törvényszék", "Debreceni Járásbíróság"), so each rank is the kind alone.
  // Two kinds are ranked under a retired name as well, because a decision
  // carries the name in force when it was handed down: Legfelsőbb Bíróság is
  // the Kúria before 2012, and megyei/fővárosi bíróság the törvényszék before
  // 2013. The közigazgatási és munkaügyi bíróságok sat from 2013 to 2020 and
  // rank between the törvényszék that absorbed them and the járásbíróság, in
  // the same tier as the district courts but above them by weight.
  HUN: {
    type: "ranked-by-name",
    rows: [
      {
        courtPattern: "alkotmánybíróság",
        ...RANK.constitutional,
      },
      {
        courtPattern: "kúria|legfelsőbb bíróság",
        ...RANK.supreme,
      },
      {
        courtPattern: "ítélőtábla",
        ...RANK.appeal,
      },
      {
        courtPattern: "törvényszék|megyei bíróság|fővárosi bíróság",
        ...RANK.regional,
      },
      {
        courtPattern: "közigazgatási és munkaügyi bíróság",
        ...RANK["administrative-labour"],
      },
      {
        courtPattern: "járásbíróság|kerületi bíróság|városi bíróság",
        ...RANK.district,
      },
    ],
  },
  EU: {
    type: "ranked-by-name",
    rows: [
      {
        courtPattern: "court of justice",
        ...RANK.constitutional,
      },
      {
        courtPattern: "general court",
        ...RANK.supreme,
      },
    ],
  },
  // A USA decision ranks by its court id's directory tier (`court-ranks.ts`),
  // never through a name row. The one row is the name rank the registry held
  // before USA decisions carried a court id, kept so the table keeps the key
  // its seed migration wrote; nothing reads a court id from it.
  USA: {
    type: "ranked-by-court-id",
    legacyRows: [
      {
        courtPattern: "^supreme court of the united states$",
        ...RANK.supreme,
      },
    ],
  },
} as const satisfies Record<CaseLawJurisdiction, CourtWeightSeedDisposition>;

const seededPatterns = (
  disposition: CourtWeightSeedDisposition,
): readonly CourtWeightSeedPattern[] => {
  switch (disposition.type) {
    case "ranked-by-name":
      return disposition.rows;
    case "ranked-by-court-id":
      return disposition.legacyRows;
    default:
      disposition satisfies never;
      return panic(
        `Unhandled court weight seed disposition: ${JSON.stringify(disposition)}`,
      );
  }
};

/** The table's rows, in the declaration's jurisdiction order. */
export const COURT_WEIGHT_SEED: readonly CourtWeightSeedRow[] = Object.keys(
  COURT_WEIGHT_SEED_BY_JURISDICTION,
)
  .filter(isCaseLawJurisdiction)
  .flatMap((country) =>
    seededPatterns(COURT_WEIGHT_SEED_BY_JURISDICTION[country]).map(
      ({ courtPattern, tier, tierLabel, weight }) => ({
        country,
        courtPattern,
        tier,
        tierLabel,
        weight,
      }),
    ),
  );

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
  country: CaseLawJurisdiction,
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
