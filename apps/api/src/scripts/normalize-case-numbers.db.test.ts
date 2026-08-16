import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawCitations,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { CITATION_RESOLUTION_STATUS } from "@/api/handlers/case-law/citation-resolution-status";
import { createSafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";
import {
  normalizeSheetNumbersStatement,
  sheetNumberSurveyStatement,
} from "@/api/scripts/normalize-case-numbers-sql";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * An operator script's SQL is never executed by anything else, so a statement
 * assembled by hand in one is unreviewable in the only way that counts: a
 * missing comma between two CTEs is a syntax error the database rejects on the
 * first invocation and no test ever sees. These execute the real statements.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const sourceId = createSafeId<"caseLawSource">();
const withSheet = createSafeId<"caseLawDecision">();
const withoutIdentity = createSafeId<"caseLawDecision">();
const citing = createSafeId<"caseLawDecision">();
const edge = createSafeId<"caseLawCitation">();

const base = {
  sourceId,
  court: "Krajský soud",
  country: "CZE",
  language: "cs",
};

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    await db
      .insert(caseLawSources)
      .values({ id: sourceId, adapterKey: "cz-regional", name: "test source" });

    await db.insert(caseLawDecisions).values([
      {
        ...base,
        id: withSheet,
        caseNumber: "11 C 153/2025-28",
        citationKey: "11c/153/2025-28",
        sourceDocumentId: "doc-1",
        decisionDate: "2025-03-01",
        slug: "with-sheet",
        languageGroupKey: "with-sheet",
      },
      {
        // No publisher id, so it is still identified by its case number and
        // must not be rewritten.
        ...base,
        id: withoutIdentity,
        caseNumber: "12 C 154/2025-30",
        citationKey: "12c/154/2025-30",
        decisionDate: "2025-03-02",
        slug: "without-identity",
        languageGroupKey: "without-identity",
      },
      {
        ...base,
        id: citing,
        caseNumber: "30 Co 9/2026",
        citationKey: "30co/9/2026",
        sourceDocumentId: "doc-2",
        decisionDate: "2026-01-01",
        slug: "citing",
        languageGroupKey: "citing",
      },
    ]);

    await db.insert(caseLawCitations).values({
      id: edge,
      citingDecisionId: citing,
      citedDecisionId: withSheet,
      citationText: "11 C 153/2025-28",
      citationKey: "11c/153/2025-28",
      resolutionStatus: CITATION_RESOLUTION_STATUS.RESOLVED,
    });
  },
  { timeout: 120_000 },
);

afterAll(async () => {
  await client.close();
});

/**
 * `execute` yields rows directly on the server driver and wraps them in
 * `{ rows }` under pglite, the same split the production readers handle.
 */
const executedRows = (result: unknown): unknown[] => {
  if (Array.isArray(result)) {
    return result;
  }
  if (isRecord(result) && Array.isArray(result["rows"])) {
    return result["rows"];
  }
  return [];
};

const firstRow = (result: unknown): Record<string, unknown> => {
  const row: unknown = executedRows(result).at(0);
  if (!isRecord(row)) {
    throw new Error("statement returned no row");
  }
  return row;
};

test("the survey counts what can and cannot be split", async () => {
  const row = firstRow(await db.execute(sheetNumberSurveyStatement()));
  expect(row["ready"]).toBe(1);
  expect(row["blocked"]).toBe(1);
});

test("the normalization splits the docket and retracts its edges", async () => {
  const row = firstRow(await db.execute(normalizeSheetNumbersStatement(100)));
  expect(row["normalized"]).toBe(1);
  // Clearing the key retracts the edge drawn to it: what the citation matched
  // was a docket carrying a sheet number, which was never the docket.
  expect(row["reopened"]).toBe(1);

  const [split] = await db
    .select({
      caseNumber: caseLawDecisions.caseNumber,
      sheetNumber: caseLawDecisions.sheetNumber,
      citationKey: caseLawDecisions.citationKey,
    })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, withSheet));
  expect(split).toEqual({
    caseNumber: "11 C 153/2025",
    sheetNumber: "28",
    citationKey: null,
  });

  const [reopened] = await db
    .select({
      cited: caseLawCitations.citedDecisionId,
      status: caseLawCitations.resolutionStatus,
    })
    .from(caseLawCitations)
    .where(eq(caseLawCitations.id, edge));
  expect(reopened).toEqual({
    cited: null,
    status: CITATION_RESOLUTION_STATUS.PENDING,
  });

  // The row identified by its case number is left alone, so re-running it
  // would collapse no distinct rows onto one key.
  const [untouched] = await db
    .select({ caseNumber: caseLawDecisions.caseNumber })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.id, withoutIdentity));
  expect(untouched?.caseNumber).toBe("12 C 154/2025-30");
});

test("a second pass finds nothing, so the walk terminates", async () => {
  const row = firstRow(await db.execute(normalizeSheetNumbersStatement(100)));
  expect(row["normalized"]).toBe(0);
});
