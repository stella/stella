import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { PUBLIC_CASE_LAW_PAGE_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSitemapCountryGenerations,
  caseLawSitemapShardCounts,
  caseLawSitemapShards,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  invalidateCaseLawSitemapShardsTx,
  refreshCaseLawSitemapShards,
} from "@/api/lib/case-law/sitemap-shard-refresh";
import {
  lockCaseLawRemovalSnapshots,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("sitemap shard invalidation interleaving (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("sitemap shard invalidation interleaving (postgres)", () => {
    const { db } = openGatedTestDatabase(databaseUrl);

    test("does not stage a count whose country generation changed after its snapshot", async () => {
      const country = PUBLIC_CASE_LAW_PAGE_COUNTRIES.at(0);
      if (country === undefined) {
        throw new Error("Sitemap country list is empty");
      }
      await db
        .delete(caseLawSitemapCountryGenerations)
        .where(eq(caseLawSitemapCountryGenerations.country, country));
      await db
        .delete(caseLawSitemapShardCounts)
        .where(eq(caseLawSitemapShardCounts.country, country));
      const sourceId = createSafeId<"caseLawSource">();
      const decisionId = createSafeId<"caseLawDecision">();
      await db.insert(caseLawSources).values(
        caseLawSourceRow({
          id: sourceId,
          adapterKey: `sitemap-${sourceId}`,
          name: "Sitemap count source",
        }),
      );
      await db.insert(caseLawDecisions).values({
        id: decisionId,
        sourceId,
        country,
        court: "Court",
        language: "en",
        caseNumber: "1/2024",
        decisionDate: "2024-01-01",
      });
      const transaction = db.transaction.bind(db);
      let invalidated = false;
      const interleavedDb = asTestRaw<
        Parameters<typeof refreshCaseLawSitemapShards>[0]
      >({
        transaction: async <T>(run: (tx: Transaction) => Promise<T>) => {
          const milestones = new Set<string>();
          const result = await transaction(async (tx) => {
            const monitored = new Proxy(tx, {
              get: (target, property) => {
                if (property !== "execute") {
                  const value = Reflect.get(target, property, target);
                  return typeof value === "function"
                    ? value.bind(target)
                    : value;
                }
                return async (query: Parameters<Transaction["execute"]>[0]) => {
                  const statement =
                    typeof query === "string"
                      ? query
                      : new PgDialect().sqlToQuery(query.getSQL()).sql;
                  if (
                    statement.includes(
                      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
                    )
                  ) {
                    milestones.add("count-snapshot");
                  }
                  return await target.execute(query);
                };
              },
            });
            return await run(monitored);
          });
          if (milestones.has("count-snapshot") && !invalidated) {
            invalidated = true;
            await withAggregateTransaction(db, async (tx) => {
              await lockCaseLawRemovalSnapshots(tx);
              await tx
                .update(caseLawDecisions)
                .set({ redactedAt: new Date() })
                .where(eq(caseLawDecisions.id, decisionId));
              await invalidateCaseLawSitemapShardsTx(tx, country);
            });
          }
          return result;
        },
      });

      try {
        const outcome = await refreshCaseLawSitemapShards(interleavedDb, {
          runBudgetMs: Number.MAX_SAFE_INTEGER,
        });
        expect(invalidated).toBe(true);
        expect(outcome.type).toBe("counting");
        expect(
          await db
            .select({ country: caseLawSitemapShardCounts.country })
            .from(caseLawSitemapShardCounts)
            .where(eq(caseLawSitemapShardCounts.country, country)),
        ).toEqual([]);
        expect(
          await db
            .select({ generation: caseLawSitemapCountryGenerations.generation })
            .from(caseLawSitemapCountryGenerations)
            .where(eq(caseLawSitemapCountryGenerations.country, country)),
        ).toEqual([{ generation: 1n }]);
        const resumed = await refreshCaseLawSitemapShards(db, {
          runBudgetMs: Number.MAX_SAFE_INTEGER,
        });
        expect(resumed.type).toBe("swapped");
      } finally {
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
        await db
          .delete(caseLawSitemapShards)
          .where(eq(caseLawSitemapShards.country, country));
        await db
          .delete(caseLawSitemapCountryGenerations)
          .where(eq(caseLawSitemapCountryGenerations.country, country));
        await db
          .delete(caseLawSitemapShardCounts)
          .where(eq(caseLawSitemapShardCounts.country, country));
      }
    });
  });
}
