import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import * as v from "valibot";

import { waitForExternalState } from "@stll/property-testing/external-state";

import {
  caseLawDecisions,
  caseLawSitemapChanges,
  caseLawSitemapCountryGenerations,
  caseLawSitemapShards,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  invalidateCaseLawSitemapShardsTx,
  refreshCaseLawSitemapShards,
  SITEMAP_WHOLE_COUNTRY,
} from "@/api/lib/case-law/sitemap-shard-refresh";
import {
  lockCaseLawRemovalSnapshots,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)("monthly sitemap removal fence (postgres)", () => {
  const databaseUrl =
    process.env["DATABASE_URL"] ?? panic("PostgreSQL URL required");
  const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
  const country = "XSR";
  const sourceId = createSafeId<"caseLawSource">();
  const decisionId = createSafeId<"caseLawDecision">();
  cleanUp(async () => {
    await db
      .delete(caseLawDecisions)
      .where(eq(caseLawDecisions.sourceId, sourceId));
    await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    await db
      .delete(caseLawSitemapShards)
      .where(eq(caseLawSitemapShards.country, country));
    await db
      .delete(caseLawSitemapChanges)
      .where(eq(caseLawSitemapChanges.country, country));
    await db
      .delete(caseLawSitemapCountryGenerations)
      .where(eq(caseLawSitemapCountryGenerations.country, country));
  });

  test("generation inserts and updates keep a whole-generationCountry row beside a monthly change in the same transaction", async () => {
    const generationCountry = "XSG";
    const generationSourceId = createSafeId<"caseLawSource">();
    const generationDecisionId = createSafeId<"caseLawDecision">();
    cleanUp(async () => {
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, generationSourceId));
      await db
        .delete(caseLawSources)
        .where(eq(caseLawSources.id, generationSourceId));
      await db
        .delete(caseLawSitemapChanges)
        .where(eq(caseLawSitemapChanges.country, generationCountry));
      await db
        .delete(caseLawSitemapCountryGenerations)
        .where(eq(caseLawSitemapCountryGenerations.country, generationCountry));
    });
    await db.insert(caseLawSources).values(
      caseLawSourceRow({
        id: generationSourceId,
        adapterKey: `generation-${generationSourceId}`,
        name: "Generation sitemap source",
      }),
    );
    await withAggregateTransaction(db, async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
      await lockCaseLawRemovalSnapshots(tx);
      await tx.insert(caseLawDecisions).values({
        id: generationDecisionId,
        sourceId: generationSourceId,
        country: generationCountry,
        court: "Court",
        language: "en",
        caseNumber: "1/2024",
        decisionDate: "2024-01-01",
      });
      await invalidateCaseLawSitemapShardsTx(tx, generationCountry);
      await invalidateCaseLawSitemapShardsTx(tx, generationCountry);
    });
    expect(
      await db
        .select({ generation: caseLawSitemapCountryGenerations.generation })
        .from(caseLawSitemapCountryGenerations)
        .where(eq(caseLawSitemapCountryGenerations.country, generationCountry)),
    ).toEqual([{ generation: 2n }]);
    expect(
      await db
        .select({
          year: caseLawSitemapChanges.year,
          month: caseLawSitemapChanges.month,
        })
        .from(caseLawSitemapChanges)
        .where(eq(caseLawSitemapChanges.country, generationCountry))
        .orderBy(caseLawSitemapChanges.id),
    ).toEqual([
      { year: "2024", month: "01" },
      { year: SITEMAP_WHOLE_COUNTRY, month: SITEMAP_WHOLE_COUNTRY },
    ]);
  });

  test("a concurrent removal cannot be republished by a monthly count", async () => {
    await db.insert(caseLawSources).values(
      caseLawSourceRow({
        id: sourceId,
        adapterKey: `monthly-${sourceId}`,
        name: "Monthly sitemap source",
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
    const counted = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let paused = false;
    const interleaved = asTestRaw<
      Parameters<typeof refreshCaseLawSitemapShards>[0]
    >({
      transaction: async <T>(
        run: (
          tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
        ) => Promise<T>,
      ) =>
        await db.transaction(
          async (tx) =>
            await run(
              new Proxy(tx, {
                get: (target, property) => {
                  if (property !== "execute") {
                    const value = Reflect.get(target, property, target);
                    return typeof value === "function"
                      ? value.bind(target)
                      : value;
                  }
                  return async (query: Parameters<typeof tx.execute>[0]) => {
                    const text =
                      typeof query === "string"
                        ? query
                        : new PgDialect().sqlToQuery(query.getSQL()).sql;
                    const rows = await target.execute(query);
                    if (!paused && text.includes("WITH logged AS")) {
                      paused = true;
                      counted.resolve(undefined);
                      await release.promise;
                    }
                    return rows;
                  };
                },
              }),
            ),
        ),
    });
    const refreshing = Result.tryPromise(
      async () => await refreshCaseLawSitemapShards(interleaved),
    );
    try {
      await Promise.race([
        counted.promise,
        refreshing.then(() =>
          panic("Refresh finished before its monthly count"),
        ),
      ]);
      const removing = Result.tryPromise(
        async () =>
          await withAggregateTransaction(db, async (tx) => {
            await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
            await lockCaseLawRemovalSnapshots(tx);
            await tx
              .update(caseLawDecisions)
              .set({ redactedAt: new Date() })
              .where(eq(caseLawDecisions.id, decisionId));
            await invalidateCaseLawSitemapShardsTx(tx, country);
          }),
      );
      await waitForExternalState({
        description:
          "removal commits its generation or waits on the monthly snapshot fence",
        read: async () => {
          const state = v.parse(
            v.object({ finished: v.boolean(), waiting: v.boolean() }),
            executedRows(
              await db.execute(sql`SELECT
            EXISTS (SELECT 1 FROM case_law_sitemap_country_generations WHERE country = ${country} AND generation > 0) AS finished,
            EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'LOCK TABLE case_law_browse_facet_counts%') AS waiting`),
            ).at(0),
          );
          return state.finished || state.waiting;
        },
      });
      release.resolve(undefined);
      expect(Result.isOk(await refreshing)).toBe(true);
      expect(Result.isOk(await removing)).toBe(true);
      expect(
        await db
          .select()
          .from(caseLawSitemapShards)
          .where(eq(caseLawSitemapShards.country, country)),
      ).toEqual([]);
      expect(
        await db
          .select({ generation: caseLawSitemapCountryGenerations.generation })
          .from(caseLawSitemapCountryGenerations)
          .where(eq(caseLawSitemapCountryGenerations.country, country)),
      ).toEqual([{ generation: 1n }]);
      expect(
        await db
          .select({
            year: caseLawSitemapChanges.year,
            month: caseLawSitemapChanges.month,
          })
          .from(caseLawSitemapChanges)
          .where(eq(caseLawSitemapChanges.country, country)),
      ).toContainEqual({
        year: SITEMAP_WHOLE_COUNTRY,
        month: SITEMAP_WHOLE_COUNTRY,
      });
      // A later run rebuilds from the post-removal corpus, consuming its log.
      await refreshCaseLawSitemapShards(
        asTestRaw<Parameters<typeof refreshCaseLawSitemapShards>[0]>(db),
      );
      expect(
        await db
          .select()
          .from(caseLawSitemapShards)
          .where(eq(caseLawSitemapShards.country, country)),
      ).toEqual([]);
    } finally {
      release.resolve(undefined);
      await refreshing;
    }
  });
});
