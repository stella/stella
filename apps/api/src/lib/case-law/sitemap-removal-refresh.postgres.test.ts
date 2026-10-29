import { panic, Result } from "better-result";
import { beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import nodePath from "node:path";
import * as v from "valibot";

import { waitForExternalState } from "@stll/property-testing/external-state";

import { runMigrations } from "@/api/db/migration-runner";
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
import { SITEMAP_ALL_BUCKET } from "@/api/lib/case-law/sitemap-shard-sql";
import {
  lockCaseLawRemovalSnapshots,
  withAggregateTransaction,
} from "@/api/lib/db/aggregate-lock";
import { executedRows } from "@/api/lib/db/executed-rows";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const REFRESH_TIMEOUT_MS = 10_000;

describe.skipIf(!enabled)("monthly sitemap removal fence (postgres)", () => {
  const databaseUrl =
    process.env["DATABASE_URL"] ?? panic("PostgreSQL URL required");
  const databaseName = `sitemap_removal_${Bun.randomUUIDv7().replaceAll("-", "")}`;
  const fixtureUrl = new URL(databaseUrl);
  fixtureUrl.pathname = `/${databaseName}`;
  const { db, sql: client } = openGatedTestDatabase(fixtureUrl.href);
  const competitor = openGatedTestDatabase(fixtureUrl.href);
  const admin = openGatedTestDatabase(databaseUrl);
  const country = "XSR";
  const sourceId = createSafeId<"caseLawSource">();
  const decisionId = createSafeId<"caseLawDecision">();
  admin.cleanUp(async () => {
    // Dropping the database requires both fixture pools to be closed,
    // regardless of the test runner's ordering of the gated cleanup hooks.
    await client.close();
    await competitor.sql.close();
    await admin.db.execute(
      sql`DROP DATABASE IF EXISTS ${sql.identifier(databaseName)}`,
    );
  });
  // timeout: a fresh database must apply the complete committed migration bundle before either concurrency test starts.
  beforeAll(async () => {
    await admin.db.execute(
      sql`CREATE DATABASE ${sql.identifier(databaseName)} TEMPLATE template0`,
    );
    const connection = await client.reserve();
    try {
      await runMigrations({
        connection,
        migrationsFolder: nodePath.resolve(import.meta.dir, "../../../drizzle"),
        databaseUrl: fixtureUrl.href,
        ebs: { type: "disabled" },
      });
    } finally {
      await connection.release();
    }
  }, 120_000);

  test("generation inserts and updates keep a whole-country row beside a monthly change in the same transaction", async () => {
    const generationCountry = "XSG";
    const generationSourceId = createSafeId<"caseLawSource">();
    const generationDecisionId = createSafeId<"caseLawDecision">();
    try {
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
          .where(
            eq(caseLawSitemapCountryGenerations.country, generationCountry),
          ),
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
    } finally {
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
    }
  });

  // timeout: bounded refresh waits cover initial publication, a competing drain, and the post-removal rebuild, plus the concurrent removal fence.
  test(
    "a concurrent removal cannot be republished by a monthly count",
    async () => {
      await db.insert(caseLawSources).values(
        caseLawSourceRow({
          id: sourceId,
          adapterKey: `monthly-${sourceId}`,
          name: "Monthly sitemap source",
        }),
      );
      const survivorId = createSafeId<"caseLawDecision">();
      const publishedAt = new Date("2024-03-01T00:00:00Z");
      await db.insert(caseLawDecisions).values([
        {
          id: decisionId,
          sourceId,
          country,
          court: "Court",
          language: "en",
          caseNumber: "1/2024",
          decisionDate: "2024-01-01",
          updatedAt: publishedAt,
        },
        {
          id: survivorId,
          sourceId,
          country,
          court: "Court",
          language: "en",
          caseNumber: "2/2024",
          decisionDate: "2024-02-01",
          updatedAt: publishedAt,
        },
      ]);
      const refreshDb =
        asTestRaw<Parameters<typeof refreshCaseLawSitemapShards>[0]>(db);
      // Broad invalidations can defer work to the next incremental run, even
      // though this database's change log belongs exclusively to this suite.
      const refreshUntilCountryDrained = async (database = refreshDb) =>
        await waitForExternalState({
          description: `${country} sitemap change log is drained`,
          timeoutMs: REFRESH_TIMEOUT_MS,
          read: async () => {
            await refreshCaseLawSitemapShards(database);
            const pending = await db
              .select({ id: caseLawSitemapChanges.id })
              .from(caseLawSitemapChanges)
              .where(eq(caseLawSitemapChanges.country, country))
              .limit(1);
            return pending.length === 0;
          },
        });
      await refreshUntilCountryDrained();
      expect(
        await db
          .select()
          .from(caseLawSitemapChanges)
          .where(eq(caseLawSitemapChanges.country, country)),
      ).toEqual([]);
      expect(
        await db
          .select({ month: caseLawSitemapShards.month })
          .from(caseLawSitemapShards)
          .where(eq(caseLawSitemapShards.country, country))
          .orderBy(caseLawSitemapShards.month),
      ).toEqual([{ month: "01" }, { month: "02" }]);
      // Only January is dirty. Removal retires February too, so its rebuilding
      // depends on the generation trigger's whole-country invalidation.
      await db
        .update(caseLawDecisions)
        .set({ updatedAt: new Date("2024-04-01T00:00:00Z") })
        .where(eq(caseLawDecisions.id, decisionId));
      // Reproduce a competing refresher consuming the first January change.
      // Once it finishes, the isolated log lets this test own the next change
      // through its count/removal interleaving instead of hoping it stays dirty.
      await refreshUntilCountryDrained(
        asTestRaw<Parameters<typeof refreshCaseLawSitemapShards>[0]>(
          competitor.db,
        ),
      );
      expect(
        await db
          .select({ lastModifiedAt: caseLawSitemapShards.lastModifiedAt })
          .from(caseLawSitemapShards)
          .where(eq(caseLawSitemapShards.country, country))
          .orderBy(caseLawSitemapShards.month),
      ).toEqual([
        { lastModifiedAt: new Date("2024-04-01T00:00:00Z") },
        { lastModifiedAt: publishedAt },
      ]);
      await db
        .update(caseLawDecisions)
        .set({ updatedAt: new Date("2024-05-01T00:00:00Z") })
        .where(eq(caseLawDecisions.id, decisionId));
      const counted = Promise.withResolvers<undefined>();
      const release = Promise.withResolvers<undefined>();
      const removalCommitted = Promise.withResolvers<undefined>();
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
                      const compiled =
                        typeof query === "string"
                          ? { sql: query, params: undefined }
                          : new PgDialect().sqlToQuery(query.getSQL());
                      const text = compiled.sql;
                      if (
                        paused &&
                        text.includes("SELECT country, year, month")
                      ) {
                        await removalCommitted.promise;
                      }
                      const rows = await target.execute(query);
                      if (
                        !paused &&
                        text.includes("WITH logged AS") &&
                        compiled.params?.includes(country)
                      ) {
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
            panic(
              "The isolated January change was not counted; it was consumed or skipped before the removal fence",
            ),
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
        ).finally(() => removalCommitted.resolve(undefined));
        await waitForExternalState({
          description:
            "removal commits its generation or waits on the monthly snapshot fence",
          read: async () => {
            const state = v.parse(
              v.object({ finished: v.boolean(), waiting: v.boolean() }),
              executedRows(
                await db.execute(sql`SELECT
            EXISTS (SELECT 1 FROM case_law_sitemap_country_generations WHERE country = ${country} AND generation > 0) AS finished,
            EXISTS (SELECT 1 FROM pg_locks
              WHERE database = (SELECT oid FROM pg_database WHERE datname = current_database())
                AND relation = 'public.case_law_browse_facet_counts'::regclass
                AND NOT granted) AS waiting`),
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
        await refreshUntilCountryDrained();
        const recount = v.parse(
          v.array(
            v.object({
              year: v.string(),
              month: v.string(),
              bucket: v.string(),
              total: v.number(),
              lastModifiedAt: v.date(),
            }),
          ),
          executedRows(
            await db.execute(sql`SELECT
        COALESCE(to_char(d.decision_date, 'YYYY'), 'undated') AS year,
        COALESCE(to_char(d.decision_date, 'MM'), '00') AS month,
        ${SITEMAP_ALL_BUCKET}::text AS bucket, count(*)::int AS total,
        max(d.updated_at) AS "lastModifiedAt"
        FROM case_law_published_decisions d JOIN case_law_sources s ON s.id = d.source_id
        WHERE d.country = ${country}
          AND (s.descriptor IS NULL OR s.descriptor ->> 'allowsRedistribution' = 'true')
        GROUP BY 1, 2 ORDER BY 1, 2`),
          ),
        );
        expect(recount).toEqual([
          {
            year: "2024",
            month: "02",
            bucket: SITEMAP_ALL_BUCKET,
            total: 1,
            lastModifiedAt: publishedAt,
          },
        ]);
        expect(
          await db
            .select({
              year: caseLawSitemapShards.year,
              month: caseLawSitemapShards.month,
              bucket: caseLawSitemapShards.bucket,
              total: caseLawSitemapShards.total,
              lastModifiedAt: caseLawSitemapShards.lastModifiedAt,
            })
            .from(caseLawSitemapShards)
            .where(eq(caseLawSitemapShards.country, country))
            .orderBy(
              caseLawSitemapShards.year,
              caseLawSitemapShards.month,
              caseLawSitemapShards.bucket,
            ),
        ).toEqual(recount);
      } finally {
        release.resolve(undefined);
        removalCommitted.resolve(undefined);
        await refreshing;
      }
    },
    4 * REFRESH_TIMEOUT_MS,
  );
});
