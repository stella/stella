import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import * as v from "valibot";

import {
  caseLawCoverageSummaries,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { readCaseLawCoverageHandler } from "@/api/handlers/case-law/decisions/coverage";
import { coverageSnapshotSchema } from "@/api/handlers/case-law/public-response-schemas";
import { createSafeId } from "@/api/lib/branded-types";
import type {
  CaseLawPublicReadDb,
  CaseLawPublicReadTransaction,
} from "@/api/lib/case-law-public-read-db";
import { executedRows } from "@/api/lib/db/executed-rows";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { isRecord } from "@/api/lib/type-guards";
import {
  CASE_LAW_COVERAGE_FIXTURE,
  CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
} from "@/api/tests/helpers/case-law-coverage-fixture";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import {
  createTestPglite,
  withPublicLawReaderRole,
} from "@/api/tests/pglite-test-db";

const GENERATED_AT = new Date(CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE.generatedAt);
const afterSeconds = (seconds: number) =>
  new Date(GENERATED_AT.getTime() + seconds * 1000);
// The fixture's response is served one minute after the answer was computed.
const SERVED_AT = afterSeconds(60);
const WITHHELD_DESCRIPTOR = {
  license: "restricted",
  attribution: null,
  allowsRedistribution: false,
  allowsDerivedAi: false,
} as const;

const createReaderDb = async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });
  const readDb = asTestRaw<CaseLawPublicReadDb>(
    async (read: Parameters<CaseLawPublicReadDb>[0]) =>
      await withPublicLawReaderRole(
        db,
        async (tx) => await read(asTestRaw<CaseLawPublicReadTransaction>(tx)),
      ),
  );
  return { client, db, readDb };
};

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
    expect(await readCaseLawCoverageHandler(readDb, SERVED_AT)).toEqual({
      message: "Coverage is unavailable",
    });
    expect(statements).toHaveLength(1);
    await db.insert(caseLawCoverageSummaries).values({
      key: "current",
      sourcePolicy: "[]",
      answer: CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
      generatedAt: GENERATED_AT,
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
      const answer = await readCaseLawCoverageHandler(readDb, SERVED_AT);
      expect(answer).toEqual(CASE_LAW_COVERAGE_FIXTURE);
      // The allowed relation is the budget: any corpus read fails even if
      // it uses a fixed statement count or a warm process-local cache.
      expect(statements).toHaveLength(1);
      expect(statements.at(0)).toContain(
        "stella_case_law_coverage_summary_v2()",
      );
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
      .set({ descriptor: WITHHELD_DESCRIPTOR })
      .where(eq(caseLawSources.id, sourceId));
    statements.length = 0;
    const revoked = await readCaseLawCoverageHandler(readDb, SERVED_AT);
    expect(revoked).toEqual({ message: "Coverage is unavailable" });
    expect(statements).toHaveLength(1);
  } finally {
    await client.close();
  }
}, 120_000);

// timeout: embedded PostgreSQL builds the complete migration schema for this test.
test("coverage returns unavailable when a stored answer does not match the current schema", async () => {
  const { client, db, readDb } = await createReaderDb();
  try {
    await db.insert(caseLawCoverageSummaries).values({
      key: "current",
      sourcePolicy: "[]",
      answer: sql`'{"countries": []}'::jsonb`,
      generatedAt: GENERATED_AT,
    });
    expect(await readCaseLawCoverageHandler(readDb, SERVED_AT)).toEqual({
      message: "Coverage is unavailable",
    });
    await db
      .update(caseLawCoverageSummaries)
      .set({ answer: CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE })
      .where(eq(caseLawCoverageSummaries.key, "current"));
    expect(await readCaseLawCoverageHandler(readDb, SERVED_AT)).toEqual(
      CASE_LAW_COVERAGE_FIXTURE,
    );
  } finally {
    await client.close();
  }
}, 120_000);

// timeout: embedded PostgreSQL builds the complete migration schema for this test.
test("coverage serves the last permitted answer as refresh pending until a refresh lands", async () => {
  const { client, db, readDb } = await createReaderDb();
  const countedSourceId = createSafeId<"caseLawSource">();
  try {
    // Counted by the snapshot: it existed when the answer was computed.
    await db
      .insert(caseLawSources)
      .values(caseLawSourceRow({ id: countedSourceId }));
    await db.insert(caseLawCoverageSummaries).values({
      key: "current",
      sourcePolicy: "[]",
      answer: CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
      generatedAt: GENERATED_AT,
    });

    // Up to three refresh intervals still read as current; a day does not.
    expect(await readCaseLawCoverageHandler(readDb, afterSeconds(900))).toEqual(
      {
        ...CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
        freshness: { status: "current", ageSeconds: 900 },
      },
    );
    expect(
      await readCaseLawCoverageHandler(readDb, afterSeconds(86_400)),
    ).toEqual({
      ...CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
      freshness: { status: "refresh_pending", ageSeconds: 86_400 },
    });

    // Withheld from the start and added after the answer: nothing of it was
    // counted, so the answer stands, pending the refresh under the new policy.
    await db.insert(caseLawSources).values(
      caseLawSourceRow({
        adapterKey: ADAPTER_KEYS.SK_US,
        descriptor: WITHHELD_DESCRIPTOR,
        createdAt: afterSeconds(30),
      }),
    );
    expect(await readCaseLawCoverageHandler(readDb, SERVED_AT)).toEqual({
      ...CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
      freshness: { status: "refresh_pending", ageSeconds: 60 },
    });

    // A counted source losing redistribution takes the whole answer with it:
    // its share of the index figures cannot be subtracted exactly.
    await db
      .update(caseLawSources)
      .set({ descriptor: WITHHELD_DESCRIPTOR })
      .where(eq(caseLawSources.id, countedSourceId));
    expect(await readCaseLawCoverageHandler(readDb, SERVED_AT)).toEqual({
      message: "Coverage is unavailable",
    });
  } finally {
    await client.close();
  }
}, 120_000);

/**
 * The reader of releases before the versioned function: the original function
 * parsed directly as the stored answer. It must keep answering during a
 * rolling deploy exactly as it did.
 */
const readPreviousCoverage = async (
  readDb: CaseLawPublicReadDb,
): Promise<unknown> =>
  await readDb(async (tx) => {
    const row = executedRows(
      await tx.execute(
        sql`SELECT public.stella_case_law_coverage_summary() AS answer`,
      ),
    ).at(0);
    const answer = isRecord(row) ? row["answer"] : null;
    if (answer === null) {
      return { message: "Coverage is unavailable" };
    }
    const parsed = v.safeParse(coverageSnapshotSchema, answer);
    return parsed.success
      ? parsed.output
      : { message: "Coverage is unavailable" };
  });

// timeout: embedded PostgreSQL builds the complete migration schema for this test.
test("the previous release's reader keeps its answers beside the versioned one", async () => {
  const { client, db, readDb } = await createReaderDb();
  const countedSourceId = createSafeId<"caseLawSource">();
  try {
    await db
      .insert(caseLawSources)
      .values(caseLawSourceRow({ id: countedSourceId }));
    expect(await readPreviousCoverage(readDb)).toEqual({
      message: "Coverage is unavailable",
    });
    await db.insert(caseLawCoverageSummaries).values({
      key: "current",
      sourcePolicy: "[]",
      answer: CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
      generatedAt: GENERATED_AT,
    });
    expect(await readPreviousCoverage(readDb)).toEqual(
      CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
    );
    expect(await readCaseLawCoverageHandler(readDb, SERVED_AT)).toEqual(
      CASE_LAW_COVERAGE_FIXTURE,
    );

    // The original refuses on any policy difference; the versioned reader
    // serves the same answer as pending a refresh.
    await db.insert(caseLawSources).values(
      caseLawSourceRow({
        adapterKey: ADAPTER_KEYS.SK_US,
        descriptor: WITHHELD_DESCRIPTOR,
        createdAt: afterSeconds(30),
      }),
    );
    expect(await readPreviousCoverage(readDb)).toEqual({
      message: "Coverage is unavailable",
    });
    expect(await readCaseLawCoverageHandler(readDb, SERVED_AT)).toEqual({
      ...CASE_LAW_COVERAGE_SNAPSHOT_FIXTURE,
      freshness: { status: "refresh_pending", ageSeconds: 60 },
    });
  } finally {
    await client.close();
  }
}, 120_000);
