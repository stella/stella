import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import nodePath from "node:path";

import {
  US_COURT_NAMES,
  US_COURTS,
  type UsCourt,
} from "@stll/api-contract/us-courts";

import { authRelationsPart } from "@/api/db/auth-schema";
import {
  caseLawCitations,
  caseLawCourtWeights,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { readCitationGraphFacts } from "@/api/handlers/case-law/analysis/significance";
import { CITATION_KIND } from "@/api/handlers/case-law/citation-kind";
import { courtWeightSql } from "@/api/handlers/case-law/citation-score";
import {
  COURT_WEIGHT_SEED,
  courtWeightMapFromSeed,
  seededCourtWeightEntries,
} from "@/api/handlers/case-law/court-weight-seed";
import { selectShelfCourts } from "@/api/handlers/case-law/decisions/shelf-courts";
import { createSafeId } from "@/api/lib/branded-types";
import type { CaseLawPublicReadTransaction } from "@/api/lib/case-law-public-read-db";
import { courtPresentation } from "@/api/lib/case-law/court-presentation";
import {
  UNRANKED_COURT_RANK,
  US_TIER_RANK,
} from "@/api/lib/case-law/court-ranks";
import { courtTierLabel } from "@/api/lib/case-law/court-tiers";
import {
  citingCourtWeight,
  courtTierLabelFromMap,
  courtTierSqlFromMap,
  type CourtWeightMap,
  decisionCourtWeight,
  flattenCourtWeightEntries,
} from "@/api/lib/case-law/court-weights";
import { resetPublicCaseLawConfigForTesting } from "@/api/lib/case-law/public-case-law-config";
import { requireCourtPartitionIdentity } from "@/api/lib/legal-search/corpus-index-group-contract";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const migrationPath = (directory: string) =>
  nodePath.resolve(
    import.meta.dir,
    "../../../drizzle",
    directory,
    "migration.sql",
  );

const FULL_SEED = migrationPath(
  "20260918210100_case_law_court_weight_seed_hun",
);
const USA_SEED = migrationPath("20260926120200_case_law_court_weight_seed_usa");

type TestDb = ReturnType<typeof drizzle>;

const USA_ROWS = COURT_WEIGHT_SEED.filter((row) => row.country === "USA");

const byKey = (
  left: { country: string; courtPattern: string },
  right: { country: string; courtPattern: string },
): number =>
  `${left.country}:${left.courtPattern}` <
  `${right.country}:${right.courtPattern}`
    ? -1
    : 1;

const applyMigration = async (db: TestDb, path: string): Promise<void> => {
  const statements = (await Bun.file(path).text())
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) {
    await db.execute(sql.raw(statement));
  }
};

/** Every row, keyed and ordered so two reads compare field by field. */
const readRegistry = async (db: TestDb) =>
  (await db.select().from(caseLawCourtWeights))
    .map(({ country, courtPattern, id, tier, tierLabel, weight }) => ({
      country,
      courtPattern,
      id,
      tier,
      tierLabel,
      weight,
    }))
    .toSorted((left, right) =>
      `${left.country}:${left.courtPattern}` <
      `${right.country}:${right.courtPattern}`
        ? -1
        : 1,
    );

test("the seed migrations apply, reconcile stale rows, and are idempotent", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  // A database seeded by an older script holds the key at another rank, and
  // carries a pattern the declaration has since widened.
  await db.insert(caseLawCourtWeights).values([
    {
      id: createSafeId<"caseLawCourtWeight">(),
      country: "EU",
      courtPattern: "general court",
      tier: 1,
      tierLabel: "stale",
      weight: 1,
    },
    {
      id: createSafeId<"caseLawCourtWeight">(),
      country: "POL",
      courtPattern: "sąd apelacyjny",
      tier: 2,
      tierLabel: "appeal",
      weight: 5,
    },
  ]);
  await applyMigration(db, FULL_SEED);
  await applyMigration(db, USA_SEED);
  const first = await db.select().from(caseLawCourtWeights);
  expect(first).toHaveLength(COURT_WEIGHT_SEED.length);
  expect(
    first.find(
      (row) => row.country === "EU" && row.courtPattern === "general court",
    ),
  ).toMatchObject({ tier: 3, tierLabel: "supreme", weight: 8 });
  expect(
    first.filter(
      (row) =>
        row.country === "POL" && /sąd apelacyjny/u.test(row.courtPattern),
    ),
  ).toMatchObject([
    {
      courtPattern: "sąd apelacyjny|wojewódzki sąd administracyjny",
      tierLabel: "appeal",
      weight: 5,
    },
  ]);
  expect(first.filter((row) => row.country === "USA")).toHaveLength(
    USA_ROWS.length,
  );
  // Together the two leave exactly the declaration.
  expect(
    first
      .map(({ country, courtPattern, tier, tierLabel, weight }) => ({
        country,
        courtPattern,
        tier,
        tierLabel,
        weight,
      }))
      .toSorted((left, right) =>
        `${left.country}:${left.courtPattern}` <
        `${right.country}:${right.courtPattern}`
          ? -1
          : 1,
      ),
  ).toEqual(
    COURT_WEIGHT_SEED.toSorted((left, right) =>
      `${left.country}:${left.courtPattern}` <
      `${right.country}:${right.courtPattern}`
        ? -1
        : 1,
    ),
  );
  await applyMigration(db, FULL_SEED);
  await applyMigration(db, USA_SEED);
  const second = await db.select().from(caseLawCourtWeights);
  expect(second).toHaveLength(COURT_WEIGHT_SEED.length);
  expect(
    second.find((row) => row.country === "EU" && row.tierLabel === "supreme")
      ?.weight,
  ).toBe(8);
  await client.close();
}, 60_000);

test("the USA seed writes no row of another jurisdiction", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  await applyMigration(db, FULL_SEED);
  // Rows the USA seed must leave exactly as it finds them: one at a rank the
  // declaration does not hold, and one pattern it does not carry, both of the
  // kind the full seed would reconcile.
  await db.execute(
    sql`UPDATE case_law_court_weights SET tier = 1, tier_label = 'stale', weight = 1 WHERE country = 'EU' AND court_pattern = 'general court'`,
  );
  await db.insert(caseLawCourtWeights).values({
    id: createSafeId<"caseLawCourtWeight">(),
    country: "CZE",
    courtPattern: "okresní soud",
    tier: 1,
    tierLabel: "district",
    weight: 2,
  });
  const before = await readRegistry(db);
  expect(before.some((row) => row.country === "USA")).toBe(false);

  await applyMigration(db, USA_SEED);
  const after = await readRegistry(db);
  expect(after.filter((row) => row.country !== "USA")).toEqual(before);
  expect(
    after
      .filter((row) => row.country === "USA")
      .map(({ country, courtPattern, tier, tierLabel, weight }) => ({
        country,
        courtPattern,
        tier,
        tierLabel,
        weight,
      })),
  ).toEqual(USA_ROWS.toSorted(byKey));

  await applyMigration(db, USA_SEED);
  expect(await readRegistry(db)).toEqual(after);
  await client.close();
}, 60_000);

/** The court directory's rank for each accepted court: the oracle below. */
const directoryRankOf = (court: UsCourt) => US_TIER_RANK[court.tier];

/** Every rank SQL path over `d`, the columns the Postgres paths read. */
const rankSql = (map: CourtWeightMap) => ({
  tier: courtTierSqlFromMap({
    countryColumn: "d.country",
    courtColumn: "d.court",
    courtIdColumn: "d.court_id",
    map,
  }),
  weight: courtWeightSql({
    countryColumn: "d.country",
    courtColumn: "d.court",
    courtIdColumn: "d.court_id",
    entries: flattenCourtWeightEntries(map),
  }),
});

// The admission invariant. A USA decision is identified by its court id, and
// every path that ranks one must read that id's directory tier: the Postgres
// search tier and citing-court weight, the corpus search's rerank, the court
// chip and facet a reader is shown, the significance read, and the projection
// that files the decision under its court. Run over every court the directory
// accepts, so any accepted court can be admitted to writing without a path
// that ranks it by name, or at a default, behind it.
test("every accepted United States court ranks by its id alike in every path", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  await applyMigration(db, FULL_SEED);
  await applyMigration(db, USA_SEED);
  const map = courtWeightMapFromSeed();

  // Not vacuous: courts that share a source name hold different ids and
  // different ranks, so no reading of the name could rank both correctly.
  const bySourceName = Map.groupBy(US_COURTS, ({ sourceName }) =>
    sourceName.toLowerCase(),
  );
  const sharedNameRanks = [...bySourceName.values()]
    .filter((courts) => courts.length > 1)
    .map((courts) => new Set(courts.map((court) => directoryRankOf(court))));
  expect(sharedNameRanks.some((ranks) => ranks.size > 1)).toBe(true);
  expect(new Set(US_COURT_NAMES).size).toBe(US_COURTS.length);

  const sourceId = createSafeId<"caseLawSource">();
  const subjectId = createSafeId<"caseLawDecision">();
  const citing = US_COURTS.map((court) => ({
    court,
    id: createSafeId<"caseLawDecision">(),
  }));
  await db.insert(caseLawSources).values(caseLawSourceRow({ id: sourceId }));
  await db.insert(caseLawDecisions).values([
    {
      id: subjectId,
      sourceId,
      caseNumber: "usa-subject",
      court: "Supreme Court of the United States",
      courtId: "scotus",
      country: "USA",
      language: "en",
      decisionDate: "2000-01-01",
    },
    ...citing.map(({ court, id }) => ({
      id,
      sourceId,
      caseNumber: `usa-${court.id}`,
      court: court.canonicalName,
      courtId: court.id,
      country: "USA",
      language: "en",
      decisionDate: "2020-01-01",
    })),
  ]);
  await db.insert(caseLawCitations).values(
    citing.map(({ court, id }) => ({
      citingDecisionId: id,
      citedDecisionId: subjectId,
      citationText: `usa-${court.id}`,
      kind: CITATION_KIND.PRECEDENT,
    })),
  );

  // One statement ranks every court, as stored.
  const { tier, weight } = rankSql(map);
  const executed = await db.execute<{
    court_id: string;
    tier: number;
    weight: number;
  }>(
    sql`SELECT d.court_id, (${tier})::int AS tier, (${weight})::int AS weight
          FROM case_law_decisions d
         WHERE d.source_id = ${sourceId} AND d.id <> ${subjectId}`,
  );
  const inPostgres = new Map(
    executed.rows.map((row) => [
      row.court_id,
      { tier: row.tier, weight: row.weight },
    ]),
  );
  expect(inPostgres.size).toBe(US_COURTS.length);

  const disagreeing = US_COURTS.flatMap((court) => {
    const rank = directoryRankOf(court);
    const decision = {
      court: court.canonicalName,
      country: "USA",
      courtId: court.id,
    };
    const observed = {
      sql: inPostgres.get(court.id),
      rerank: decisionCourtWeight(map, decision),
      citing: citingCourtWeight(map, decision),
      presented: courtPresentation(map, { ...decision, ecli: null }).courtTier,
      facet: courtTierLabelFromMap(map, court.canonicalName, "USA"),
      projected: requireCourtPartitionIdentity(decision),
    };
    const expected = {
      sql: { tier: rank.tier, weight: rank.weight },
      rerank: { tier: rank.tier, weight: rank.weight },
      citing: rank.weight,
      presented: courtTierLabel(rank.tier),
      facet: courtTierLabel(rank.tier),
      projected: { courtId: court.id, courtPartition: court.courtPartition },
    };
    return Bun.deepEquals(observed, expected)
      ? []
      : [{ id: court.id, observed, expected }];
  });
  expect(disagreeing).toEqual([]);

  // The apex shelf lists exactly the courts the directory ranks supreme.
  const shelved = selectShelfCourts({
    counts: US_COURTS.map(({ canonicalName }) => ({
      court: canonicalName,
      count: 0,
    })),
    country: "USA",
    entries: seededCourtWeightEntries("USA"),
    limit: US_COURTS.length,
  });
  expect(shelved.map(({ court }) => court).toSorted()).toEqual(
    US_COURTS.filter((court) => court.tier === "supreme")
      .map(({ canonicalName }) => canonicalName)
      .toSorted(),
  );

  // The significance read ranks the same citing courts from the database.
  resetPublicCaseLawConfigForTesting();
  const readDb = drizzle({
    client,
    relations: { ...relations, ...authRelationsPart },
  });
  const facts = await readCitationGraphFacts({
    decisionId: subjectId,
    // SAFETY: the owner handle has the read surface the public reader has.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- PGlite owner handle stands in for the public read transaction
    tx: readDb as unknown as CaseLawPublicReadTransaction,
  });
  resetPublicCaseLawConfigForTesting();
  const countsByTier = Map.groupBy(
    US_COURTS,
    (court) => directoryRankOf(court).tier,
  );
  expect(facts?.countsByCourtTier).toEqual(
    [...countsByTier]
      .map(([rankTier, courts]) => ({ tier: rankTier, count: courts.length }))
      .toSorted((left, right) => left.tier - right.tier),
  );
  await client.close();
}, 60_000);

// A USA row always stores an accepted id: the table CHECK requires one and the
// write boundary admits no other. A row that holds none anyway takes the
// unranked rank in SQL and fails in TypeScript; neither reads its name, even a
// name the registry still ranks.
test("a USA row without an accepted court id never ranks by its name", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  const map = courtWeightMapFromSeed();
  const scotus = "Supreme Court of the United States";
  const malformed = [null, "test", "Scotus", "no-such-court"];
  const { tier, weight } = rankSql(map);
  const values = sql.join(
    [
      ...malformed.map((courtId) => sql`('USA', ${scotus}, ${courtId}::text)`),
      // The control: the same name in a jurisdiction ranked by name.
      sql`('XNM', ${scotus}, NULL::text)`,
    ],
    sql`, `,
  );
  const executed = await db.execute<{ tier: number; weight: number }>(
    sql`SELECT (${tier})::int AS tier, (${weight})::int AS weight
          FROM (VALUES ${values}) AS d(country, court, court_id)`,
  );
  expect(executed.rows).toEqual([
    ...malformed.map(() => ({ ...UNRANKED_COURT_RANK })),
    { tier: 3, weight: 8 },
  ]);
  for (const courtId of malformed) {
    expect(() =>
      decisionCourtWeight(map, { court: scotus, country: "USA", courtId }),
    ).toThrow("Unranked directory court id");
  }
  await client.close();
}, 60_000);
