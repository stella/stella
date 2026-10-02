import { Result, panic } from "better-result";
import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { databaseRelations } from "@/api/db/database-relations";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { czNsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-ns";
import { runIngestionPipeline } from "@/api/handlers/case-law/ingestion/pipeline";
import { createSafeId } from "@/api/lib/branded-types";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { remainingCycleMs } from "@/api/lib/legal-search/cycle-deadline";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

import {
  createSourceStoredTotalAdmission,
  SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS,
} from "./source-total-admission";
import { sourceStoredTotalCountQuery } from "./source-totals";

test("a real pipeline deadline admits one exact count and persists its pair", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client, relations: databaseRelations });
  const scopedDb: ScopedDb = async (callback) =>
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
      return await callback(asTestRaw<Transaction>(tx));
    });
  const sourceId = createSafeId<"caseLawSource">();
  const originalFetchPage = czNsAdapter.fetchPage;
  try {
    await db.insert(caseLawSources).values({
      id: sourceId,
      adapterKey: ADAPTER_KEYS.CZ_NS,
      name: "Pipeline total source",
      storedTotalNextRefreshAt: new Date(0),
    });
    await db.insert(caseLawDecisions).values(
      [1, 2].map((index) => ({
        sourceId,
        caseNumber: `Pipeline total ${index}`,
        country: "CZE",
        court: "Court",
        language: "cs",
      })),
    );
    const lease = await acquireCaseLawSourceIngestionLease({
      scopedDb,
      sourceId,
    });
    if (lease === null) {
      return panic("Expected source ingestion lease");
    }
    czNsAdapter.fetchPage = async () =>
      Result.ok({ decisions: [], nextCursor: null });
    const budgetMs = 300_000;
    const startedAt = performance.now();
    let admissions = 0;
    let counts = 0;
    const admit = createSourceStoredTotalAdmission({
      readVerdict: async () => ({ kind: "normal", signals: [] }),
    });
    try {
      await runIngestionPipeline({
        scopedDb,
        source: lease.source,
        sourceLease: lease,
        cycle: { budgetMs },
        acquireStoredTotalAdmission: async ({ deadline }) => {
          admissions += 1;
          if (deadline === undefined) {
            return panic("Pipeline omitted its real cycle deadline");
          }
          expect(deadline.expiresAt).toBeGreaterThanOrEqual(
            startedAt + budgetMs,
          );
          expect(deadline.expiresAt).toBeLessThanOrEqual(
            performance.now() + budgetMs,
          );
          const before = remainingCycleMs(deadline);
          const result = await admit({ deadline });
          expect(result).toBe("granted");
          expect(before - remainingCycleMs(deadline)).toBeGreaterThanOrEqual(
            SOURCE_STORED_TOTAL_OPERATION_BUDGET_MS,
          );
          return result;
        },
        countStoredTotalSource: async (id) => {
          counts += 1;
          expect(admissions).toBe(1);
          expect(id).toBe(sourceId);
          const total = (
            await db.execute(sourceStoredTotalCountQuery(id))
          ).rows.at(0)?.["total"];
          if (typeof total !== "number") {
            return panic("Missing exact fixture total");
          }
          return total;
        },
      });
    } finally {
      await lease.release();
    }
    expect(admissions).toBe(1);
    expect(counts).toBe(1);
    const row = (
      await db
        .select({
          total: caseLawSources.storedTotal,
          asOf: caseLawSources.storedTotalAsOf,
        })
        .from(caseLawSources)
        .where(eq(caseLawSources.id, sourceId))
        .limit(1)
    ).at(0);
    expect(row?.total).toBe(2);
    expect(row?.asOf).toBeInstanceOf(Date);
  } finally {
    czNsAdapter.fetchPage = originalFetchPage;
    await client.close();
  }
}, 120_000);
