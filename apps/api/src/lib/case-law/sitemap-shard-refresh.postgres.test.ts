/**
 * The sitemap change log against the schema the migrations build, where its
 * triggers are installed, in the shared test database other suites write to
 * at the same time: a change is consumed only by a count that sees it, a
 * writer still open through a whole run waits for the run after its commit,
 * and overlapping runs never interleave on one month.
 *
 * Each test owns its own years of one synthetic country and reads only them.
 *
 * Runs in the Postgres job; skipped elsewhere.
 */
import { panic } from "better-result";
import type { SQL as BunSql } from "bun";
import { describe, expect, test } from "bun:test";
import { asc, eq, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  caseLawDecisions,
  caseLawSitemapChanges,
  caseLawSitemapShards,
  caseLawSources,
} from "@/api/db/schema";
import { createSafeId, type SafeId } from "@/api/lib/branded-types";
import { refreshCaseLawSitemapShards } from "@/api/lib/case-law/sitemap-shard-refresh";
import { SITEMAP_ALL_BUCKET } from "@/api/lib/case-law/sitemap-shard-sql";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import { refreshCaseLawSitemapShardsTask } from "@/api/lib/scheduler/tasks/case-law-sitemap-shard-refresh";
import {
  openGatedTestDatabase,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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

    /** The fixture country's logged months of one year, oldest row first. */
    const loggedMonths = async (year: string) =>
      (
        await db
          .select({
            year: caseLawSitemapChanges.year,
            month: caseLawSitemapChanges.month,
          })
          .from(caseLawSitemapChanges)
          .where(eq(caseLawSitemapChanges.country, COUNTRY))
          .orderBy(asc(caseLawSitemapChanges.id))
      )
        .filter((logged) => logged.year === year)
        .map(({ month }) => `${year}/${month}`);

    /** The fixture country's listed months of one year, with their totals. */
    const listedMonths = async (year: string) =>
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
          .orderBy(asc(caseLawSitemapShards.month))
      )
        .filter((listed) => listed.year === year)
        .map(({ month, bucket, total }) => {
          expect(bucket).toBe(SITEMAP_ALL_BUCKET);
          return `${year}/${month}:${String(total)}`;
        });

    /** One run, and whether it left a row of the fixture country logged. */
    const refreshOnce = async () => {
      const outcome = await refreshCaseLawSitemapShards(refreshDb);
      const [left] = await db
        .select({ id: caseLawSitemapChanges.id })
        .from(caseLawSitemapChanges)
        .where(eq(caseLawSitemapChanges.country, COUNTRY))
        .limit(1);
      return outcome.type === "refreshed" && left === undefined;
    };

    /**
     * Consecutive runs until one finishes with nothing of the fixture country
     * logged. A month a run has already worked waits for the next run if it
     * is logged again meanwhile (as a whole-country expansion logs it), and
     * other suites keep logging their own countries.
     */
    const refreshUntilDone = async () => {
      for (let run = 0; run < 100; run += 1) {
        // db-await-in-loop: consecutive scheduler runs, each continuing from the rows still logged
        if (await refreshOnce()) {
          return;
        }
      }
      panic("The refresh never finished");
    };

    test("the migrated triggers log one row per month per transaction", async () => {
      const ids = await insertDecisions("1901-01-15", 3);
      expect(await loggedMonths("1901")).toEqual(["1901/01"]);
      await refreshUntilDone();
      expect(await listedMonths("1901")).toEqual(["1901/01:3"]);
      expect(await loggedMonths("1901")).toEqual([]);

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
      expect(await loggedMonths("1901")).toEqual(["1901/01"]);
      await refreshUntilDone();
      expect(await listedMonths("1901")).toEqual(["1901/01:3"]);
      expect(await loggedMonths("1901")).toEqual([]);

      await db.transaction(async (tx) => {
        await tx
          .update(caseLawDecisions)
          .set({ decisionDate: "1901-02-15" })
          .where(inArray(caseLawDecisions.id, ids.slice(0, 2)));
      });
      expect(await loggedMonths("1901")).toEqual(["1901/01", "1901/02"]);
      await refreshUntilDone();
      expect(await listedMonths("1901")).toEqual(["1901/01:1", "1901/02:2"]);
      expect(await loggedMonths("1901")).toEqual([]);
    });

    /**
     * Under the deployed roles: the ingestion role's decision write logs its
     * month through the owner-run trigger, while neither the ingestion role
     * can read or mutate logged work; the application role may only append
     * removal invalidation work.
     */
    test("ingestion logs through its trigger and application invalidation only appends", async () => {
      await insertDecisions("1905-03-15", 1);
      await refreshUntilDone();
      expect(await loggedMonths("1905")).toEqual([]);
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const session = openClient().sql;
        const id = createSafeId<"caseLawDecision">();
        decisionIds.push(id);
        await session.begin(async (tx) => {
          await tx`SET LOCAL ROLE stella_ingestion`;
          await tx`INSERT INTO case_law_decisions (id, source_id, source_document_id, country, language, court, case_number, decision_date, metadata)
            VALUES (${id}::uuid, ${sourceId}::uuid, ${`sitemap-changes-${id}`}, ${COUNTRY}, 'xx', 'Sitemap change log fixture court', ${id}, '1905-01-15', '{}'::jsonb)`;
        });
        expect(await loggedMonths("1905")).toEqual(["1905/01"]);

        const refused = async (
          role: string,
          query: (tx: BunSql) => Promise<unknown>,
        ) =>
          await session
            .begin(async (tx) => {
              await tx.unsafe(`SET LOCAL ROLE ${role}`);
              await query(tx);
              return "allowed";
            })
            .catch((error: unknown) =>
              error instanceof Error ? error.message : String(error),
            );
        for (const role of ["stella_ingestion", "stella"]) {
          // db-await-in-loop: each role is probed in its own transaction
          expect(
            await refused(
              role,
              async (tx) =>
                await tx`SELECT count(*) FROM case_law_sitemap_changes`,
            ),
          ).toMatch(/permission denied/u);
          // db-await-in-loop: each role is probed in its own transaction
          const inserted = await refused(
            role,
            async (tx) =>
              await tx`INSERT INTO case_law_sitemap_changes (country, year, month) VALUES (${COUNTRY}, '1905', '02')`,
          );
          if (role === "stella") {
            expect(inserted).toBe("allowed");
          } else {
            expect(inserted).toMatch(/permission denied/u);
          }
          // db-await-in-loop: neither writer may consume the owner's pending work
          expect(
            await refused(
              role,
              async (tx) => await tx`DELETE FROM case_law_sitemap_changes`,
            ),
          ).toMatch(/permission denied/u);
        }
        expect(await loggedMonths("1905")).toEqual(["1905/01", "1905/02"]);
      });
      await refreshUntilDone();
      expect(await loggedMonths("1905")).toEqual([]);
      expect(await listedMonths("1905")).toEqual(["1905/01:1", "1905/03:1"]);
    });

    test("a change still uncommitted through a whole run waits for the run after its commit", async () => {
      const moved =
        (await insertDecisions("1902-01-15", 2)).at(0) ??
        panic("Expected a decision to move");
      await refreshUntilDone();
      expect(await listedMonths("1902")).toEqual(["1902/01:2"]);

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

        // The writer's log rows are invisible to the whole run, so nothing
        // of its change is counted or consumed.
        await refreshUntilDone();
        expect(await listedMonths("1902")).toEqual(["1902/01:2"]);

        release.resolve(undefined);
        await writing;
      });

      // Committed, logged, and not yet counted.
      expect(await loggedMonths("1902")).toEqual(["1902/01", "1902/02"]);
      await refreshUntilDone();
      expect(await loggedMonths("1902")).toEqual([]);
      expect(await listedMonths("1902")).toEqual(["1902/01:1", "1902/02:1"]);
    });

    test("overlapping runs never interleave on a month, and a change one count misses stays logged", async () => {
      await insertDecisions("1904-01-15", 1);
      await refreshUntilDone();
      expect(await listedMonths("1904")).toEqual(["1904/01:1"]);
      await insertDecisions("1904-01-16", 1);

      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        // SAFETY: the second session's refresh opens its transactions
        // through the gated handle, the same surface the root pool provides.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- second test session stands in for an overlapping run
        const runB = openClient().db as unknown as RefreshDb;
        const state = { paused: false };
        // Run A counts January and, before writing that count, waits while
        // a newer change of the month commits and run B works the log in
        // its own session.
        const dialect = new PgDialect();
        const pause = async () => {
          await insertDecisions("1904-01-17", 1);
          expect(await refreshCaseLawSitemapShards(runB)).toMatchObject({
            type: "pending",
            retry: "delayed",
          });
          const continuations: Date[] = [];
          const before = Date.now();
          await refreshCaseLawSitemapShardsTask(
            asTestRaw({
              db: runB,
              dueAt: DueSlot.of({
                nextRunAt: new Date("2000-01-01"),
                lockedAt: new Date("2000-01-01"),
              }),
              logger,
              runId: createSafeId<"schedulerJobRun">(),
              scheduleContinuation: (at: Date) => {
                continuations.push(at);
              },
              signal: new AbortController().signal,
            }),
          );
          expect(continuations).toHaveLength(1);
          expect(continuations.at(0)?.getTime()).toBeGreaterThanOrEqual(
            before + 60_000,
          );
          expect(continuations.at(0)?.getTime()).toBeLessThanOrEqual(
            Date.now() + 60_000,
          );
          // B found the month held and left it, with its newer row, alone.
          expect(await listedMonths("1904")).toEqual(["1904/01:1"]);
          expect(await loggedMonths("1904")).toEqual(["1904/01", "1904/01"]);
        };
        const runA = {
          transaction: async (work: (tx: unknown) => Promise<unknown>) =>
            await db.transaction(
              async (tx) =>
                await work(
                  new Proxy(tx, {
                    get: (target, property, receiver) =>
                      property === "execute"
                        ? async (query: SQL) => {
                            const result = await target.execute(query);
                            const rendered = dialect.sqlToQuery(query);
                            if (
                              !state.paused &&
                              rendered.sql.includes("count(*)::int AS total") &&
                              rendered.params.includes("1904")
                            ) {
                              state.paused = true;
                              await pause();
                            }
                            return result;
                          }
                        : Reflect.get(target, property, receiver),
                  }),
                ),
            ),
        };
        // SAFETY: forwards every transaction to the gated handle.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- interposing wrapper around the test handle
        const runADb = runA as unknown as RefreshDb;
        expect(await refreshCaseLawSitemapShards(runADb)).toMatchObject({
          type: "pending",
          retry: "delayed",
        });
        expect(state.paused).toBe(true);
      });

      // A wrote the count its snapshot saw and consumed only the row in it;
      // the change committed after A counted is still logged.
      expect(await listedMonths("1904")).toEqual(["1904/01:2"]);
      expect(await loggedMonths("1904")).toEqual(["1904/01"]);
      await refreshUntilDone();
      expect(await listedMonths("1904")).toEqual(["1904/01:3"]);
      expect(await loggedMonths("1904")).toEqual([]);
    });
  });
}
