import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import {
  caseLawCoverageSummaries,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { readCaseLawCoverageHandler } from "@/api/handlers/case-law/decisions/coverage";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { CASE_LAW_COVERAGE_FIXTURE } from "@/api/tests/helpers/case-law-coverage-fixture";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

// timeout: embedded PostgreSQL builds the complete migration schema for this test.
test("coverage reads only the stored answer as the corpus grows, including on a cold request", async () => {
  const client = await createTestPglite();
  const statements: string[] = [];
  let measuring = false;
  const db = drizzle({
    client,
    logger: {
      logQuery: (query) => {
        if (measuring) {
          statements.push(query);
        }
      },
    },
  });
  const readDb = asTestRaw<CaseLawPublicReadDb>(
    async (read: Parameters<CaseLawPublicReadDb>[0]) =>
      await withPublicLawReaderRole(db, async (tx) => {
        measuring = true;
        try {
          return await read(asTestRaw<CaseLawPublicReadTransaction>(tx));
        } finally {
          measuring = false;
        }
      }),
  );
  const sourceId = createSafeId<"caseLawSource">();
  try {
    await db.insert(caseLawSources).values(caseLawSourceRow({ id: sourceId }));
    statements.length = 0;
    expect(await readCaseLawCoverageHandler(readDb)).toEqual({
      message: "Coverage is unavailable",
    });
    expect(statements).toHaveLength(1);
    await db.insert(caseLawCoverageSummaries).values({
      key: "current",
      sourcePolicy: "[]",
      answer: CASE_LAW_COVERAGE_FIXTURE,
      generatedAt: new Date(CASE_LAW_COVERAGE_FIXTURE.generatedAt),
    });
    const measure = async (additional: number) => {
      await db.insert(caseLawDecisions).values(
        Array.from({ length: additional }, (_, index) => ({
          sourceId,
          caseNumber: `Coverage fixture ${additional}-${index}`,
          country: "CZE",
          language: "cs",
          court: "Nejvyšší soud",
          fulltext: "Published decision text",
        })),
      );
      statements.length = 0;
      const answer = await readCaseLawCoverageHandler(readDb);
      expect(answer).toEqual(CASE_LAW_COVERAGE_FIXTURE);
      // The allowed relation is the budget: any corpus read fails even if
      // it uses a fixed statement count or a warm process-local cache.
      expect(statements).toHaveLength(1);
      expect(statements.at(0)).toContain("stella_case_law_coverage_summary()");
      expect(statements.at(0)).not.toMatch(
        /case_law_(?:decisions|sources|search_documents)/u,
      );
      return statements.length;
    };
    const at10 = await measure(10);
    const at100 = await measure(90);
    expect([at10, at100]).toEqual([1, 1]);

    await db
      .update(caseLawSources)
      .set({
        descriptor: {
          license: "restricted",
          attribution: null,
          allowsRedistribution: false,
          allowsDerivedAi: false,
        },
      })
      .where(eq(caseLawSources.id, sourceId));
    statements.length = 0;
    const revoked = await readCaseLawCoverageHandler(readDb);
    expect(revoked).toEqual({ message: "Coverage is unavailable" });
    expect(statements).toHaveLength(1);
  } finally {
    await client.close();
  }
}, 120_000);

// timeout: embedded PostgreSQL builds the complete migration schema for this test.
test("coverage returns unavailable when a stored answer does not match the current schema", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  const readDb = asTestRaw<CaseLawPublicReadDb>(
    async (read: Parameters<CaseLawPublicReadDb>[0]) =>
      await withPublicLawReaderRole(
        db,
        async (tx) => await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
      ),
  );
  try {
    await db.insert(caseLawCoverageSummaries).values({
      key: "current",
      sourcePolicy: "[]",
      answer: sql`'{"countries": []}'::jsonb`,
      generatedAt: new Date(CASE_LAW_COVERAGE_FIXTURE.generatedAt),
    });
    expect(await readCaseLawCoverageHandler(readDb)).toEqual({
      message: "Coverage is unavailable",
    });
    await db
      .update(caseLawCoverageSummaries)
      .set({ answer: CASE_LAW_COVERAGE_FIXTURE })
      .where(eq(caseLawCoverageSummaries.key, "current"));
    expect(await readCaseLawCoverageHandler(readDb)).toEqual(
      CASE_LAW_COVERAGE_FIXTURE,
    );
  } finally {
    await client.close();
  }
}, 120_000);
