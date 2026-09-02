import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import nodePath from "node:path";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import { addUtcDays, toUtcDateString } from "@/api/lib/dates";
import { CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT } from "@/api/lib/decision-date-bounds-sql";
import { isRecord } from "@/api/lib/type-guards";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The ceiling migration against a table still carrying the previous
 * constraint: it clears the rows the new ceiling refuses, swaps the CHECK,
 * and is a no-op the second time.
 */

const MIGRATION_PATH = nodePath.resolve(
  import.meta.dir,
  "../../drizzle/20260902100000_case_law_decision_date_ceiling/migration.sql",
);

const PREVIOUS_CONSTRAINT = `
  ALTER TABLE "case_law_decisions"
    ADD CONSTRAINT "${CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT}"
    CHECK (
      "decision_date" IS NULL
      OR (
        "decision_date" >= make_date(1800, 1, 1)
        AND "decision_date" < make_date(
          extract(year from (now() AT TIME ZONE 'UTC'))::int + 2, 1, 1)
      )
    )`;

const day = (offset: number) => toUtcDateString(addUtcDays(new Date(), offset));

const constraintDefinition = async (
  db: ReturnType<typeof drizzle>,
): Promise<string | null> => {
  const result: unknown = await db.execute(sql`
    SELECT pg_get_constraintdef(oid) AS definition, convalidated
      FROM pg_constraint
     WHERE conname = ${CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT}
       AND conrelid = 'case_law_decisions'::regclass
  `);
  let rows: unknown[] = [];
  if (Array.isArray(result)) {
    rows = result;
  } else if (isRecord(result) && Array.isArray(result["rows"])) {
    rows = result["rows"];
  }
  const row = rows.at(0);
  if (!isRecord(row) || typeof row["definition"] !== "string") {
    return null;
  }
  expect(row["convalidated"]).toBe(true);
  return row["definition"];
};

test("the ceiling migration clears future rows, swaps the CHECK, and is idempotent", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  // Start from the previous constraint, the state a deployed table is in.
  await db.execute(
    sql.raw(
      `ALTER TABLE "case_law_decisions" DROP CONSTRAINT "${CASE_LAW_DECISION_DATE_BOUNDS_CONSTRAINT}"`,
    ),
  );
  await db.execute(sql.raw(PREVIOUS_CONSTRAINT));
  expect(await constraintDefinition(db)).toMatch(/extract\(year/iu);

  const sourceId = createSafeId<"caseLawSource">();
  await db
    .insert(caseLawSources)
    .values([{ id: sourceId, adapterKey: "cz-regional", name: "cz" }]);
  const keptId = createSafeId<"caseLawDecision">();
  const clearedId = createSafeId<"caseLawDecision">();
  const citingId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values([
    {
      id: keptId,
      sourceId,
      caseNumber: "1 C 1/2026",
      court: "Okresní soud",
      country: "CZE",
      language: "cs",
      decisionDate: day(1),
      indexedHash: "kept",
    },
    {
      id: clearedId,
      sourceId,
      caseNumber: "2 C 2/2026",
      court: "Okresní soud",
      country: "CZE",
      language: "cs",
      // Admitted by the previous ceiling, refused by the new one.
      decisionDate: day(40),
      indexedHash: "stale",
    },
    {
      id: citingId,
      sourceId,
      caseNumber: "3 C 3/2026",
      court: "Okresní soud",
      country: "CZE",
      language: "cs",
      decisionDate: day(0),
    },
  ]);
  // An edge resolved under the future date, and one that never touched it.
  await db.insert(caseLawCitations).values([
    {
      citingDecisionId: citingId,
      citedDecisionId: clearedId,
      citationText: "2 C 2/2026",
      resolutionStatus: "resolved",
    },
    {
      citingDecisionId: citingId,
      citedDecisionId: keptId,
      citationText: "1 C 1/2026",
      resolutionStatus: "resolved",
    },
  ]);

  const statements = (await Bun.file(MIGRATION_PATH).text())
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const apply = async () => {
    for (const statement of statements) {
      // oxlint-disable-next-line no-await-in-loop -- statements apply in order
      await db.execute(sql.raw(statement));
    }
  };

  await apply();
  expect(await constraintDefinition(db)).toContain("::date + 2");
  const rows = await db
    .select({
      id: caseLawDecisions.id,
      decisionDate: caseLawDecisions.decisionDate,
      indexedHash: caseLawDecisions.indexedHash,
    })
    .from(caseLawDecisions);
  expect(rows.find((row) => row.id === keptId)).toEqual({
    id: keptId,
    decisionDate: day(1),
    indexedHash: "kept",
  });
  expect(rows.find((row) => row.id === clearedId)).toEqual({
    id: clearedId,
    decisionDate: null,
    indexedHash: null,
  });
  // The edge decided under the cleared date is back on the walk's plate;
  // the untouched edge keeps its resolution.
  const citations = await db
    .select({
      citedDecisionId: caseLawCitations.citedDecisionId,
      citationText: caseLawCitations.citationText,
      resolutionStatus: caseLawCitations.resolutionStatus,
    })
    .from(caseLawCitations)
    .orderBy(caseLawCitations.citationText);
  expect(citations).toEqual([
    {
      citedDecisionId: keptId,
      citationText: "1 C 1/2026",
      resolutionStatus: "resolved",
    },
    {
      citedDecisionId: null,
      citationText: "2 C 2/2026",
      resolutionStatus: "pending",
    },
  ]);

  await apply();
  expect(await constraintDefinition(db)).toContain("::date + 2");
  await client.close();
}, 120_000);
