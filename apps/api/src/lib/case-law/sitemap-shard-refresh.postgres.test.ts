/**
 * The sitemap change log against the schema the migrations build, where its
 * triggers are installed, with a second session holding a writer open: a
 * change whose transaction is still running when a refresh begins waits for
 * a later run, and the run after its commit counts it.
 *
 * Runs in the Postgres job; skipped elsewhere.
 */
import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  caseLawDecisions,
  caseLawSitemapChanges,
  caseLawSitemapMonthHorizons,
  caseLawSitemapShards,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { refreshCaseLawSitemapShards } from "@/api/lib/case-law/sitemap-shard-refresh";
import { SITEMAP_ALL_BUCKET } from "@/api/lib/case-law/sitemap-shard-sql";
import {
  openGatedTestDatabase,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type RefreshDb = Parameters<typeof refreshCaseLawSitemapShards>[0];

/** A synthetic country no other suite writes. */
const COUNTRY = "XSM";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("case-law sitemap change log (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("case-law sitemap change log (postgres)", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    // SAFETY: the refresh opens its transactions through the gated handle's
    // transaction surface, the same one the root pool provides.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test database stands in for the root pool
    const refreshDb = db as unknown as RefreshDb;
    const sourceId = createSafeId<"caseLawSource">();
    const decisionIds: SafeId<"caseLawDecision">[] = [];

    cleanUp(async () => {
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, sourceId));
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      await db
        .delete(caseLawSitemapShards)
        .where(eq(caseLawSitemapShards.country, COUNTRY));
      await db
        .delete(caseLawSitemapChanges)
        .where(eq(caseLawSitemapChanges.country, COUNTRY));
      await db
        .delete(caseLawSitemapMonthHorizons)
        .where(eq(caseLawSitemapMonthHorizons.country, COUNTRY));
    });

    const insertDecisions = async (decisionDate: string, count: number) => {
      if (decisionIds.length === 0) {
        await db.insert(caseLawSources).values({
          id: sourceId,
          adapterKey: `sitemap-changes-${sourceId}`,
          name: "Sitemap change log fixture",
          enabled: false,
        });
      }
      const ids = Array.from({ length: count }, () =>
        createSafeId<"caseLawDecision">(),
      );
      decisionIds.push(...ids);
      await db.insert(caseLawDecisions).values(
        ids.map((id) => ({
          id,
          sourceId,
          sourceDocumentId: `sitemap-changes-${id}`,
          country: COUNTRY,
          court: "Sitemap change log fixture court",
          language: "xx",
          caseNumber: `sitemap-changes-${id}`,
          decisionDate,
        })),
      );
      return ids;
    };

    const loggedMonths = async () =>
      (
        await db
          .select({
            year: caseLawSitemapChanges.year,
            month: caseLawSitemapChanges.month,
          })
          .from(caseLawSitemapChanges)
          .where(eq(caseLawSitemapChanges.country, COUNTRY))
          .orderBy(asc(caseLawSitemapChanges.id))
      ).map(({ year, month }) => `${year}/${month}`);

    const listedMonths = async () =>
      (
        await db
          .select({
            year: caseLawSitemapShards.year,
            month: caseLawSitemapShards.month,
            bucket: caseLawSitemapShards.bucket,
            total: caseLawSitemapShards.total,
          })
          .from(caseLawSitemapShards)
          .where(eq(caseLawSitemapShards.country, COUNTRY))
          .orderBy(
            asc(caseLawSitemapShards.year),
            asc(caseLawSitemapShards.month),
          )
      ).map(({ year, month, bucket, total }) => {
        expect(bucket).toBe(SITEMAP_ALL_BUCKET);
        return `${year}/${month}:${String(total)}`;
      });

    const refreshUntilDone = async (handle: RefreshDb = refreshDb) => {
      for (let run = 0; run < 100; run += 1) {
        // db-await-in-loop: consecutive scheduler runs, each continuing from the rows still logged
        const outcome = await refreshCaseLawSitemapShards(handle);
        if (outcome.type === "refreshed") {
          return;
        }
      }
      panic("The refresh never finished");
    };

    test("the migrated triggers log one row per month per transaction", async () => {
      await refreshUntilDone();
      const ids = await insertDecisions("1901-01-15", 3);
      expect(await loggedMonths()).toEqual(["1901/01"]);
      await refreshUntilDone();
      expect(await listedMonths()).toEqual(["1901/01:3"]);

      await db.transaction(async (tx) => {
        await tx
          .update(caseLawDecisions)
          .set({ updatedAt: new Date("2026-01-01T00:00:00.000Z") })
          .where(inArray(caseLawDecisions.id, ids));
        await tx
          .update(caseLawDecisions)
          .set({ updatedAt: new Date("2026-01-02T00:00:00.000Z") })
          .where(inArray(caseLawDecisions.id, ids));
      });
      expect(await loggedMonths()).toEqual(["1901/01"]);

      await db.transaction(async (tx) => {
        await tx
          .update(caseLawDecisions)
          .set({ decisionDate: "1901-02-15" })
          .where(inArray(caseLawDecisions.id, ids.slice(0, 2)));
      });
      expect(await loggedMonths()).toEqual(["1901/01", "1901/02"]);
      await refreshUntilDone();
      expect(await listedMonths()).toEqual(["1901/01:1", "1901/02:2"]);
      expect(await loggedMonths()).toEqual([]);
    });

    test("a change still uncommitted when a run begins waits for the run after its commit", async () => {
      const [moved] = await insertDecisions("1902-01-15", 2);
      await refreshUntilDone();
      expect(await listedMonths()).toContain("1902/01:2");
      if (moved === undefined) {
        return panic("Expected a decision to move");
      }

      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const writer = openClient();
        const opened = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const writing = writer.db.transaction(async (tx) => {
          await tx
            .update(caseLawDecisions)
            .set({ decisionDate: "1902-02-15" })
            .where(eq(caseLawDecisions.id, moved));
          opened.resolve(undefined);
          await release.promise;
        });
        await opened.promise;

        // The writer commits after the run has read its horizon and before
        // it lists the logged months, so its committed rows are visible to
        // the run but were written by a transaction it saw running.
        let transactions = 0;
        const interposed = {
          transaction: async (work: (tx: unknown) => Promise<unknown>) => {
            const result = await db.transaction(work);
            transactions += 1;
            if (transactions === 1) {
              release.resolve(undefined);
              await writing;
            }
            return result;
          },
        };
        // SAFETY: forwards every transaction to the gated handle.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- interposing wrapper around the test handle
        const interposedDb = interposed as unknown as RefreshDb;
        expect(await refreshCaseLawSitemapShards(interposedDb)).toMatchObject({
          type: "refreshed",
        });
      });

      // Committed, logged, and not yet counted.
      expect(await loggedMonths()).toEqual(["1902/01", "1902/02"]);
      expect(await listedMonths()).toContain("1902/01:2");
      await refreshUntilDone();
      expect(await loggedMonths()).toEqual([]);
      const listed = await listedMonths();
      expect(listed).toContain("1902/01:1");
      expect(listed).toContain("1902/02:1");
      const [counted] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(caseLawDecisions)
        .where(
          and(
            eq(caseLawDecisions.country, COUNTRY),
            sql`${caseLawDecisions.decisionDate} >= '1902-02-01' AND ${caseLawDecisions.decisionDate} < '1902-03-01'`,
          ),
        );
      expect(counted?.total).toBe(1);
    });

    test("a run that counted before an overlapping run wrote a newer count cannot overwrite it", async () => {
      await insertDecisions("1903-01-15", 1);
      await refreshUntilDone();
      expect(await listedMonths()).toContain("1903/01:1");
      await insertDecisions("1903-01-16", 1);

      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        // SAFETY: the second session's refresh opens its transactions
        // through the gated handle, the same surface the root pool provides.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- second test session stands in for an overlapping run
        const runB = openClient().db as unknown as RefreshDb;
        let paused = false;
        // Run A counts January, then waits while run B, in its own session,
        // counts a newer change of the same month, writes it and consumes
        // its log rows.
        const runA = {
          transaction: async (work: (tx: unknown) => Promise<unknown>) => {
            let counted = false;
            const result = await db.transaction(
              async (tx) =>
                await work(
                  new Proxy(tx, {
                    get: (target, property, receiver) =>
                      property === "execute"
                        ? async (query: SQL) => {
                            counted ||= new PgDialect()
                              .sqlToQuery(query)
                              .sql.includes("count(*)::int AS total");
                            return await target.execute(query);
                          }
                        : Reflect.get(target, property, receiver),
                  }),
                ),
            );
            if (counted && !paused) {
              paused = true;
              await insertDecisions("1903-01-17", 1);
              await refreshUntilDone(runB);
              expect(await listedMonths()).toContain("1903/01:3");
              expect(await loggedMonths()).toEqual([]);
            }
            return result;
          },
        };
        // SAFETY: forwards every transaction to the gated handle.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- interposing wrapper around the test handle
        const runADb = runA as unknown as RefreshDb;
        expect(await refreshCaseLawSitemapShards(runADb)).toMatchObject({
          type: "refreshed",
          months: 0,
        });
        expect(paused).toBe(true);
      });

      // Run A's write was refused: the month keeps run B's newer count.
      expect(await listedMonths()).toContain("1903/01:3");
      expect(await loggedMonths()).toEqual([]);
    });
  });
}
