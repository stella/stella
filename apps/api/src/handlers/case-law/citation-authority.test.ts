import { afterAll, beforeAll, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api-postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as authSchema from "@/api/db/auth-schema";
import * as rlsExports from "@/api/db/rls";
import * as schema from "@/api/db/schema";
import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { recomputeCitationAuthorityForAll } from "@/api/handlers/case-law/citation-authority";
import { citationScore } from "@/api/handlers/case-law/citation-score";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  createSchemaPglite,
  installPgliteSchemaPrerequisites,
} from "@/api/tests/pglite-schema";

// The materialized citation_authority column must equal citationScore()
// evaluated at the same instant, so moving the blend out of the per-query
// SQL into a precomputed column does not change ranking. `now` is pinned
// on both sides because the value decays continuously with time.

const allSchema = { ...schema, ...authSchema, ...rlsExports };
const NOW = new Date("2026-06-05T00:00:00.000Z");

let client: Awaited<ReturnType<typeof createSchemaPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();
const citedId = createSafeId<"caseLawDecision">();
const supremeCitingId = createSafeId<"caseLawDecision">();
const regionalCitingId = createSafeId<"caseLawDecision">();
const orphanId = createSafeId<"caseLawDecision">();

// The full pushSchema() DDL push against pglite is close enough to
// bun:test's 5s default hook timeout that running this file alongside
// others in the same worker occasionally tips it over; match the
// { timeout: 30_000 } convention used by the other pglite-schema
// fixtures (entity-filters.differential.test.ts, legislation/
// ingestion.test.ts).
beforeAll(
  async () => {
    client = await createSchemaPglite();
    db = drizzle({ client });
    await db.execute(sql.raw("CREATE ROLE stella NOLOGIN"));
    await db.execute(sql.raw("CREATE ROLE stella_ingestion NOLOGIN"));
    await installPgliteSchemaPrerequisites(db);
    const { sqlStatements } = await pushSchema(allSchema, db);
    for (const statement of sqlStatements) {
      // oxlint-disable-next-line no-await-in-loop -- DDL statements must apply in emitted order (deterministic test schema setup)
      await db.execute(sql.raw(statement));
    }
    // Calendar-only decision dates are UTC midnights in the TypeScript
    // reference implementation. A non-UTC database session must produce the
    // same score instead of applying its local offset during the implicit cast.
    await db.execute(sql.raw("SET TIME ZONE 'Europe/Prague'"));

    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: "test",
      name: "Test source",
    });

    await db.insert(caseLawDecisions).values([
      {
        id: citedId,
        sourceId,
        caseNumber: "1 Cdo 1/2020",
        court: "Okresní soud",
        country: "CZE",
        language: "cs",
        decisionDate: "2020-01-01",
      },
      {
        id: supremeCitingId,
        sourceId,
        caseNumber: "2 Cdo 2/2025",
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        decisionDate: "2025-01-01",
      },
      {
        id: regionalCitingId,
        sourceId,
        caseNumber: "3 Co 3/2018",
        court: "Krajský soud",
        country: "CZE",
        language: "cs",
        decisionDate: "2018-01-01",
      },
      {
        id: orphanId,
        sourceId,
        caseNumber: "4 Cdo 4/2021",
        court: "Okresní soud",
        country: "CZE",
        language: "cs",
        decisionDate: "2021-01-01",
      },
    ]);

    await db.insert(caseLawCitations).values([
      {
        citingDecisionId: supremeCitingId,
        citedDecisionId: citedId,
        citationText: "1 Cdo 1/2020",
      },
      {
        citingDecisionId: regionalCitingId,
        citedDecisionId: citedId,
        citationText: "1 Cdo 1/2020",
      },
    ]);

    await db.transaction(async (tx) =>
      recomputeCitationAuthorityForAll(tx, { now: NOW }),
    );
  },
  { timeout: 30_000 },
);

afterAll(async () => {
  await client.close();
});

const authorityOf = async (id: SafeId<"caseLawDecision">): Promise<number> => {
  const [row] = await db
    .select({ a: caseLawDecisions.citationAuthority })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, id));
  return row?.a ?? Number.NaN;
};

const countOf = async (id: SafeId<"caseLawDecision">): Promise<number> => {
  const [row] = await db
    .select({ n: caseLawDecisions.citationCount })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, id));
  return row?.n ?? Number.NaN;
};

test("materialized authority equals citationScore() at the same instant", async () => {
  const expected = citationScore(
    [
      { citingCourt: "Nejvyšší soud", citingDate: "2025-01-01" },
      { citingCourt: "Krajský soud", citingDate: "2018-01-01" },
    ],
    "2020-01-01",
    NOW,
  );

  expect(await authorityOf(citedId)).toBeCloseTo(expected, 9);
  expect(await countOf(citedId)).toBe(2);
});

test("a decision with no incoming citations has zero authority", async () => {
  expect(await authorityOf(orphanId)).toBe(0);
  expect(await countOf(orphanId)).toBe(0);
  // The citing decisions themselves are not cited by anyone.
  expect(await authorityOf(supremeCitingId)).toBe(0);
  expect(await countOf(supremeCitingId)).toBe(0);
});

test("a more authoritative citing court yields higher authority", async () => {
  // Same single citation, supreme (weight 3) vs regional (weight 2),
  // controlling for date so only court weight differs.
  const supreme = citationScore(
    [{ citingCourt: "Nejvyšší soud", citingDate: "2024-01-01" }],
    "2020-01-01",
    NOW,
  );
  const regional = citationScore(
    [{ citingCourt: "Krajský soud", citingDate: "2024-01-01" }],
    "2020-01-01",
    NOW,
  );
  expect(supreme).toBeGreaterThan(regional);
});

// Bug fix: DB-seeded court weights (case_law_court_weights, loaded via
// loadCourtWeightEntriesForSql()) were never threaded into
// recomputeCitationAuthorityForAll's SQL, so it silently always used
// LEGACY_COURT_TIERS regardless of what was seeded. This test pins the
// `courtWeightEntries` option actually reaching the generated SQL. It
// reuses the file's shared pglite fixture (adding one more decision/
// citation) rather than standing up a second pglite instance, which is
// expensive enough to trip the default hook timeout when run alongside
// the file's existing fixture.
test("courtWeightEntries option drives the SQL instead of the legacy tiers", async () => {
  // A court name that matches none of LEGACY_COURT_TIERS' CZ/SK patterns
  // (so the legacy fallback would score it at DEFAULT_WEIGHT=1), but
  // matches CUSTOM_ENTRIES below at weight 7 — proving the entries
  // actually drove the SQL rather than being silently ignored.
  const customCitedId = createSafeId<"caseLawDecision">();
  const customCitingId = createSafeId<"caseLawDecision">();
  const CUSTOM_ENTRIES = [
    {
      pattern: /^Custom Seeded Court$/u,
      tier: 5,
      tierLabel: "seeded-only",
      weight: 7,
    },
  ];

  await db.insert(caseLawDecisions).values([
    {
      id: customCitedId,
      sourceId,
      caseNumber: "5 Cdo 5/2020",
      court: "Okresní soud",
      country: "CZE",
      language: "cs",
      decisionDate: "2020-01-01",
    },
    {
      id: customCitingId,
      sourceId,
      caseNumber: "6 Cdo 6/2025",
      court: "Custom Seeded Court",
      country: "CZE",
      language: "cs",
      decisionDate: "2025-01-01",
    },
  ]);
  await db.insert(caseLawCitations).values({
    citingDecisionId: customCitingId,
    citedDecisionId: customCitedId,
    citationText: "5 Cdo 5/2020",
  });

  await db.transaction(async (tx) =>
    recomputeCitationAuthorityForAll(tx, {
      now: NOW,
      courtWeightEntries: CUSTOM_ENTRIES,
    }),
  );

  expect(await authorityOf(customCitedId)).toBeCloseTo(
    citationScore(
      [{ citingCourt: "Custom Seeded Court", citingDate: "2025-01-01" }],
      "2020-01-01",
      NOW,
      new Map([["CZE", CUSTOM_ENTRIES]]),
    ),
    9,
  );
  // Sanity check: under the legacy fallback this citing court matches no
  // pattern (DEFAULT_WEIGHT=1), which differs from the custom weight (7)
  // enough that the assertion above cannot pass by coincidence.
  expect(await authorityOf(customCitedId)).not.toBeCloseTo(
    citationScore(
      [{ citingCourt: "Custom Seeded Court", citingDate: "2025-01-01" }],
      "2020-01-01",
      NOW,
    ),
    2,
  );
});
