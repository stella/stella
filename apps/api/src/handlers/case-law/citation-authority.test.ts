import { PGlite } from "@electric-sql/pglite";
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

// The materialized citation_authority column must equal citationScore()
// evaluated at the same instant, so moving the blend out of the per-query
// SQL into a precomputed column does not change ranking. `now` is pinned
// on both sides because the value decays continuously with time.

const allSchema = { ...schema, ...authSchema, ...rlsExports };
const NOW = new Date("2026-06-05T00:00:00.000Z");

let client: PGlite;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();
const citedId = createSafeId<"caseLawDecision">();
const supremeCitingId = createSafeId<"caseLawDecision">();
const regionalCitingId = createSafeId<"caseLawDecision">();
const orphanId = createSafeId<"caseLawDecision">();

beforeAll(async () => {
  client = await PGlite.create();
  db = drizzle({ client });
  await db.execute(sql.raw("CREATE ROLE stella NOLOGIN"));
  await db.execute(sql.raw("CREATE ROLE stella_ingestion NOLOGIN"));
  const { sqlStatements } = await pushSchema(allSchema, db);
  for (const statement of sqlStatements) {
    await db.execute(sql.raw(statement));
  }

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
});

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
