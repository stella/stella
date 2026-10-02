import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawSources,
  SOURCE_TOTAL_ORIGIN,
} from "@/api/db/schema";
import type { SourceTotalOrigin } from "@/api/db/schema";
import { markRlsDatabase } from "@/api/db/scoped";
import type { TransactionOf } from "@/api/db/scoped";
import {
  estimateSourceThroughIngestionRole,
  explainSourceStoredTotalQuery,
  readSourceReportedTotals,
  refreshSourceStoredTotal,
  refreshNextSourceStoredTotal,
  setSourceReportedTotal,
  SourceReportedTotalError,
  SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
  sourceStoredTotalNextRefreshAt,
} from "@/api/handlers/case-law/ingestion/source-totals";
import { createSafeId, toSafeId, type SafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import {
  openGatedTestDatabase,
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { explainRoot } from "@/api/tests/query-plans/plan-walker";

// The trio is nullable in the schema and only this module keeps it whole, so
// what is asserted here is the writer's invariant rather than the columns:
// a set lands as all three, a rewrite replaces all three, a value no
// publisher could state is refused, and a key no source carries writes
// nothing at all.

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
let db: GatedTestDb;

const scopedDb: ScopedDb = async (callback) =>
  await db.transaction(
    async (tx) => await callback(asTestRaw<Transaction>(tx)),
  );

describe.skipIf(!enabled || databaseUrl === undefined)(
  "source totals on PostgreSQL 18",
  () => {
    if (databaseUrl === undefined) {
      return;
    }
    const fixture = openGatedTestDatabase(databaseUrl, { max: 1 });
    db = fixture.db;
    const schema = `source_totals_${Bun.randomUUIDv7().replaceAll("-", "")}`;
    fixture.cleanUp(async () => {
      await db.execute(sql.raw(`DROP SCHEMA ${schema} CASCADE`));
    });
    beforeAll(async () => {
      const version = (
        await db.execute(
          sql`SELECT current_setting('server_version_num')::int AS version`,
        )
      ).at(0)?.["version"];
      expect(version).toBeGreaterThanOrEqual(180_000);
      expect(version).toBeLessThan(190_000);
      await db.execute(sql.raw(`CREATE SCHEMA ${schema}`));
      await db.execute(
        sql.raw(
          `CREATE TABLE ${schema}.case_law_sources (LIKE public.case_law_sources INCLUDING ALL)`,
        ),
      );
      await db.execute(
        sql.raw(
          `CREATE TABLE ${schema}.case_law_decisions (LIKE public.case_law_decisions INCLUDING ALL)`,
        ),
      );
      await db.execute(
        sql.raw(`GRANT USAGE ON SCHEMA ${schema} TO stella_ingestion`),
      );
      await db.execute(
        sql.raw(
          `GRANT SELECT ON ${schema}.case_law_decisions TO stella_ingestion`,
        ),
      );
      // Copy actual production column grants, so a missing refresh-field grant fails this fixture.
      const privileges =
        await db.execute(sql`SELECT privilege_type, array_agg(column_name ORDER BY column_name) AS columns
      FROM information_schema.column_privileges
      WHERE table_schema = 'public' AND table_name = 'case_law_sources' AND grantee = 'stella_ingestion'
      GROUP BY privilege_type`);
      for (const grant of privileges) {
        const privilege = grant["privilege_type"];
        const columns = grant["columns"];
        if (
          (privilege !== "SELECT" &&
            privilege !== "UPDATE" &&
            privilege !== "INSERT") ||
          !Array.isArray(columns) ||
          !columns.every((column) => typeof column === "string")
        ) {
          continue;
        }
        // db-await-in-loop: copy the fixed set of production privileges to the isolated fixture.
        await db.execute(
          sql`GRANT ${sql.raw(privilege)} (${sql.join(
            columns.map((column) => sql.identifier(column)),
            sql`, `,
          )}) ON ${sql.identifier(schema)}.case_law_sources TO stella_ingestion`,
        );
      }
      await db.execute(sql.raw(`SET search_path TO ${schema}, public`));
    });

    const seedSource = async (): Promise<string> => {
      const id = createSafeId<"caseLawSource">();
      const adapterKey = `source-totals-${id}`;
      await db
        .insert(caseLawSources)
        .values({ id, adapterKey, name: "source totals fixture" });
      return adapterKey;
    };

    const readTrio = async (adapterKey: string) =>
      (
        await db
          .select({
            reportedTotal: caseLawSources.reportedTotal,
            reportedTotalAsOf: caseLawSources.reportedTotalAsOf,
            reportedTotalOrigin: caseLawSources.reportedTotalOrigin,
          })
          .from(caseLawSources)
          .where(eq(caseLawSources.adapterKey, adapterKey))
          .limit(1)
      ).at(0);

    test("a set lands as the whole trio and reads back", async () => {
      const adapterKey = await seedSource();
      const asOf = new Date("2026-08-11T09:00:00.000Z");

      const applied = await setSourceReportedTotal({
        scopedDb,
        adapterKey,
        total: 903_412,
        asOf,
        origin: SOURCE_TOTAL_ORIGIN.OPERATOR,
      });

      expect(applied).toBe(true);
      const rows = await readSourceReportedTotals(scopedDb);
      expect(rows.find((row) => row.adapterKey === adapterKey)).toEqual({
        adapterKey,
        reportedTotal: 903_412,
        reportedTotalAsOf: asOf,
        reportedTotalOrigin: SOURCE_TOTAL_ORIGIN.OPERATOR,
      });
    });

    test("a later set replaces every member, origin included", async () => {
      const adapterKey = await seedSource();
      await setSourceReportedTotal({
        scopedDb,
        adapterKey,
        total: 10,
        asOf: new Date("2026-08-01T00:00:00.000Z"),
        origin: SOURCE_TOTAL_ORIGIN.OPERATOR,
      });

      const asOf = new Date("2026-08-11T12:00:00.000Z");
      await setSourceReportedTotal({
        scopedDb,
        adapterKey,
        total: 11,
        asOf,
        origin: SOURCE_TOTAL_ORIGIN.ADAPTER_POLL,
      });

      expect(await readTrio(adapterKey)).toEqual({
        reportedTotal: 11,
        reportedTotalAsOf: asOf,
        reportedTotalOrigin: SOURCE_TOTAL_ORIGIN.ADAPTER_POLL,
      });
    });

    // 2_147_483_648 is one past the `integer` column's range: without the
    // writer's own bound it satisfies every "positive whole number" check and is
    // refused by PostgreSQL instead, mid-transaction.
    test.each([
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
      2_147_483_648,
    ])("a total of %p is refused and writes nothing", async (total) => {
      const adapterKey = await seedSource();

      const rejection = await setSourceReportedTotal({
        scopedDb,
        adapterKey,
        total,
        asOf: new Date("2026-08-11T09:00:00.000Z"),
        origin: SOURCE_TOTAL_ORIGIN.ADAPTER_POLL,
      }).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(SourceReportedTotalError);

      expect(await readTrio(adapterKey)).toEqual({
        reportedTotal: null,
        reportedTotalAsOf: null,
        reportedTotalOrigin: null,
      });
    });

    // The other side of the bound: the largest value the column can hold must
    // still go through, so the guard cannot drift into rejecting valid totals.
    test("the column's largest value is accepted", async () => {
      const adapterKey = await seedSource();

      const applied = await setSourceReportedTotal({
        scopedDb,
        adapterKey,
        total: 2_147_483_647,
        asOf: new Date("2026-08-11T09:00:00.000Z"),
        origin: SOURCE_TOTAL_ORIGIN.ADAPTER_POLL,
      });

      expect(applied).toBe(true);
      expect((await readTrio(adapterKey))?.reportedTotal).toBe(2_147_483_647);
    });

    test("an adapter key no source carries reports back, and writes nothing", async () => {
      const present = await seedSource();

      const applied = await setSourceReportedTotal({
        scopedDb,
        adapterKey: `${present}-absent`,
        total: 7,
        asOf: new Date("2026-08-11T09:00:00.000Z"),
        origin: SOURCE_TOTAL_ORIGIN.OPERATOR,
      });

      expect(applied).toBe(false);
      expect(await readTrio(present)).toEqual({
        reportedTotal: null,
        reportedTotalAsOf: null,
        reportedTotalOrigin: null,
      });
    });

    // The origin values live in two places by necessity: the TypeScript union and
    // the column's check constraint. Exercising every declared member against the
    // real constraint binds the two — a member added to one and not the other
    // fails here rather than at a write.
    test.each(Object.values(SOURCE_TOTAL_ORIGIN))(
      "the database accepts the declared origin %p",
      async (origin) => {
        const adapterKey = await seedSource();

        const applied = await setSourceReportedTotal({
          scopedDb,
          adapterKey,
          total: 3,
          asOf: new Date("2026-08-11T09:00:00.000Z"),
          origin,
        });

        expect(applied).toBe(true);
        expect((await readTrio(adapterKey))?.reportedTotalOrigin).toBe(origin);
      },
    );

    test("the database refuses an origin outside the declared set", async () => {
      const adapterKey = await seedSource();

      const rejection = await db
        .update(caseLawSources)
        .set({
          reportedTotal: 5,
          reportedTotalAsOf: new Date("2026-08-11T09:00:00.000Z"),
          // SAFETY: the point of this test is the value the union forbids, so
          // the cast is what lets the constraint be the thing under test.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- exercising the database's own guard against an unlisted origin
          reportedTotalOrigin: "guessed" as SourceTotalOrigin,
        })
        .where(eq(caseLawSources.adapterKey, adapterKey))
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(Error);
      expect(await readTrio(adapterKey)).toEqual({
        reportedTotal: null,
        reportedTotalAsOf: null,
        reportedTotalOrigin: null,
      });
    });

    // The writer always sets the three together, so only a path that bypasses it
    // can split them. That is exactly what the constraint exists for.
    test.each([
      ["total alone", { reportedTotal: 5 }],
      [
        "date alone",
        { reportedTotalAsOf: new Date("2026-08-11T09:00:00.000Z") },
      ],
      ["origin alone", { reportedTotalOrigin: SOURCE_TOTAL_ORIGIN.OPERATOR }],
    ])("the database refuses a partial trio: %s", async (_label, patch) => {
      const adapterKey = await seedSource();

      const rejection = await db
        .update(caseLawSources)
        .set(patch)
        .where(eq(caseLawSources.adapterKey, adapterKey))
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(Error);
      expect(await readTrio(adapterKey)).toEqual({
        reportedTotal: null,
        reportedTotalAsOf: null,
        reportedTotalOrigin: null,
      });
    });

    test("the database refuses a non-positive total written around the writer", async () => {
      const adapterKey = await seedSource();

      const rejection = await db
        .update(caseLawSources)
        .set({
          reportedTotal: 0,
          reportedTotalAsOf: new Date("2026-08-11T09:00:00.000Z"),
          reportedTotalOrigin: SOURCE_TOTAL_ORIGIN.OPERATOR,
        })
        .where(eq(caseLawSources.adapterKey, adapterKey))
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(Error);
      expect(await readTrio(adapterKey)).toEqual({
        reportedTotal: null,
        reportedTotalAsOf: null,
        reportedTotalOrigin: null,
      });
    });

    // ── the stored count ──────────────────────────────────────────────────────
    //
    // The same module owns the numerator, and what is asserted here is again the
    // writer's invariant rather than the column: it counts at most once per
    // interval, a count it cannot finish leaves the previous figure standing, and
    // a replay converges instead of fighting a concurrent worker.

    const NOW = new Date("2026-09-19T12:00:00.000Z");

    const seedCountedSource = async (rows: number, dueAt = NOW) => {
      const id = createSafeId<"caseLawSource">();
      const adapterKey = `stored-total-${id}`;
      await db.insert(caseLawSources).values({
        id,
        adapterKey,
        name: "stored total fixture",
        storedTotalNextRefreshAt: dueAt,
      });
      if (rows > 0) {
        await db.insert(caseLawDecisions).values(
          Array.from({ length: rows }, (_, index) => ({
            caseNumber: `${adapterKey}-${index}`,
            country: "CZE",
            court: "Court",
            language: "cs",
            sourceId: id,
          })),
        );
      }
      return id;
    };

    const readStoredPair = async (sourceId: SafeId<"caseLawSource">) =>
      (
        await db
          .select({
            storedTotal: caseLawSources.storedTotal,
            storedTotalAsOf: caseLawSources.storedTotalAsOf,
          })
          .from(caseLawSources)
          .where(eq(caseLawSources.id, sourceId))
          .limit(1)
      ).at(0);

    const readScheduledDue = async (sourceId: SafeId<"caseLawSource">) => {
      const due = (
        await db
          .select({ due: caseLawSources.storedTotalNextRefreshAt })
          .from(caseLawSources)
          .where(eq(caseLawSources.id, sourceId))
          .limit(1)
      ).at(0)?.due;
      if (due === null || due === undefined) {
        return panic("Expected durable source refresh schedule");
      }
      return due;
    };
    const readEligibleDue = async (sourceId: SafeId<"caseLawSource">) => {
      const row = (
        await db
          .select({
            due: caseLawSources.storedTotalNextRefreshAt,
            attempted: caseLawSources.storedTotalAttemptedAt,
            asOf: caseLawSources.storedTotalAsOf,
          })
          .from(caseLawSources)
          .where(eq(caseLawSources.id, sourceId))
          .limit(1)
      ).at(0);
      if (row === undefined || row.due === null) {
        return panic("Expected durable source refresh schedule");
      }
      const previous = Math.max(
        row.attempted?.getTime() ?? Number.NEGATIVE_INFINITY,
        row.asOf?.getTime() ?? Number.NEGATIVE_INFINITY,
      );
      return new Date(
        Math.max(
          row.due.getTime(),
          previous + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
        ),
      );
    };
    const setDue = async (sourceId: SafeId<"caseLawSource">, due: Date) => {
      await db
        .update(caseLawSources)
        .set({ storedTotalNextRefreshAt: due })
        .where(eq(caseLawSources.id, sourceId));
    };

    const estimateInTest = async (sourceId: SafeId<"caseLawSource">) =>
      (
        await db
          .select({ id: caseLawDecisions.id })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.sourceId, sourceId))
          .limit(100)
      ).length;

    const refreshForTest = async (
      options: Omit<
        Parameters<typeof refreshSourceStoredTotal>[0],
        "acquireAdmission"
      > & { acquireAdmission?: () => Promise<"granted" | "held"> },
    ) =>
      await refreshSourceStoredTotal({
        ...options,
        acquireAdmission: options.acquireAdmission ?? (async () => "granted"),
        estimateSource: options.estimateSource ?? estimateInTest,
      });

    test("an explicitly due cycle estimates the source and stamps the pair", async () => {
      const sourceId = await seedCountedSource(3);

      expect(await refreshForTest({ scopedDb, sourceId, now: NOW })).toBe(
        "refreshed",
      );
      expect(await readStoredPair(sourceId)).toEqual({
        storedTotal: 3,
        storedTotalAsOf: NOW,
      });
    });

    test("a source counted within the interval is not recounted", async () => {
      const sourceId = await seedCountedSource(2);
      await refreshForTest({ scopedDb, sourceId, now: NOW });

      // The corpus grows, but the interval has not elapsed.
      await db.insert(caseLawDecisions).values({
        caseNumber: `${sourceId}-late`,
        country: "CZE",
        court: "Court",
        language: "cs",
        sourceId,
      });
      const withinInterval = new Date(
        (await readEligibleDue(sourceId)).getTime() - 1,
      );

      expect(
        await refreshForTest({ scopedDb, sourceId, now: withinInterval }),
      ).toBe("fresh");
      // Proven by the figure, not by the return value: the old count stands.
      expect(await readStoredPair(sourceId)).toEqual({
        storedTotal: 2,
        storedTotalAsOf: NOW,
      });
    });

    test("the interval's own boundary recounts", async () => {
      const sourceId = await seedCountedSource(1);
      await refreshForTest({ scopedDb, sourceId, now: NOW });
      await db.insert(caseLawDecisions).values({
        caseNumber: `${sourceId}-second`,
        country: "CZE",
        court: "Court",
        language: "cs",
        sourceId,
      });
      const atBoundary = await readEligibleDue(sourceId);

      expect(
        await refreshForTest({ scopedDb, sourceId, now: atBoundary }),
      ).toBe("refreshed");
      expect(await readStoredPair(sourceId)).toEqual({
        storedTotal: 2,
        storedTotalAsOf: atBoundary,
      });
    });

    test("replaying a refresh is a fixed point", async () => {
      const sourceId = await seedCountedSource(4);
      await refreshForTest({ scopedDb, sourceId, now: NOW });
      const first = await readStoredPair(sourceId);

      await refreshForTest({ scopedDb, sourceId, now: NOW });

      expect(await readStoredPair(sourceId)).toEqual(first);
    });

    test("a count that cannot finish leaves the previous figure standing", async () => {
      const sourceId = await seedCountedSource(2);
      await refreshForTest({ scopedDb, sourceId, now: NOW });
      const past = await readEligibleDue(sourceId);

      const warn = spyOn(logger, "warn");
      try {
        expect(
          await refreshForTest({
            scopedDb,
            sourceId,
            now: past,
            estimateSource: async () => {
              throw Object.assign(
                new Error("canceling statement due to statement timeout"),
                { code: "57014" },
              );
            },
          }),
        ).toBe("unavailable");
        // The warning preserves the SQLSTATE while the durable attempt backs off retries.
        expect(warn).toHaveBeenCalledWith(
          "case_law.source_stored_total.unavailable",
          expect.objectContaining({ sourceId, "error.cause.pg_code": "57014" }),
        );
      } finally {
        warn.mockRestore();
      }
      expect(await readStoredPair(sourceId)).toEqual({
        storedTotal: 2,
        storedTotalAsOf: NOW,
      });
    });

    // ── the role that actually runs it ────────────────────────────────────────
    //
    // Every test above runs as the database owner, which holds every column. In
    // production this module runs as `stella_ingestion`, whose UPDATE on
    // `case_law_sources` is granted column by column, so a column added without a
    // grant is refused with 42501 and the refresh reports "unavailable" rather
    // than raising. That is how `stored_total` shipped: counted on every cycle,
    // written on none. These run the real writers under the real role.

    const ingestionScopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
        return await callback(asTestRaw<Transaction>(tx));
      });

    test("the ingestion role counts a source and writes the stored pair", async () => {
      const sourceId = await seedCountedSource(3);
      const countedAt = new Date("2026-09-22T08:00:00.000Z");
      await setDue(sourceId, countedAt);

      expect(
        await refreshForTest({
          scopedDb: ingestionScopedDb,
          sourceId,
          now: countedAt,
          estimateSource: async (id) =>
            await ingestionScopedDb(
              async (tx) =>
                (
                  await tx
                    .select({ id: caseLawDecisions.id })
                    .from(caseLawDecisions)
                    .where(eq(caseLawDecisions.sourceId, id))
                    .limit(100)
                ).length,
            ),
        }),
      ).toBe("refreshed");
      // A refused UPDATE would surface as "unavailable", and one that matched no
      // row as "fresh", so the figure is what proves the write landed.
      expect(await readStoredPair(sourceId)).toEqual({
        storedTotal: 3,
        storedTotalAsOf: countedAt,
      });
    });

    test("the planner estimate bridge reads under the ingestion role", async () => {
      const sourceId = await seedCountedSource(3);
      const observedRoles: string[] = [];
      const dedicatedDb = markRlsDatabase({
        transaction: async <T>(
          fn: (tx: TransactionOf<typeof db>) => Promise<T>,
        ): Promise<T> =>
          await db.transaction(async (tx) => {
            const value = await fn(tx);
            const role = (
              await tx.execute(sql`SELECT current_user AS role`)
            ).at(0)?.["role"];
            if (typeof role === "string") {
              observedRoles.push(role);
            }
            return value;
          }),
      });

      const estimate = await estimateSourceThroughIngestionRole(
        dedicatedDb,
        sourceId,
      );
      expect(Number.isSafeInteger(estimate)).toBe(true);
      expect(estimate).toBeGreaterThanOrEqual(0);
      expect(observedRoles).toEqual(["stella_ingestion"]);
    });

    test("the ingestion role writes the reported trio", async () => {
      const sourceId = createSafeId<"caseLawSource">();
      const adapterKey = `reported-total-role-${sourceId}`;
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey,
        name: "reported total role fixture",
      });
      const asOf = new Date("2026-09-22T08:30:00.000Z");

      expect(
        await setSourceReportedTotal({
          scopedDb: ingestionScopedDb,
          adapterKey,
          total: 42,
          asOf,
          origin: "adapter-poll",
        }),
      ).toBe(true);
      expect(await readTrio(adapterKey)).toEqual({
        reportedTotal: 42,
        reportedTotalAsOf: asOf,
        reportedTotalOrigin: "adapter-poll",
      });
    });

    test("the ingestion role is refused a source column outside the grant", async () => {
      const sourceId = await seedCountedSource(0);

      const refusal = await db
        .transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
          await tx.execute(
            sql`UPDATE case_law_sources SET name = 'renamed' WHERE id = ${sourceId}`,
          );
          return "no rejection";
        })
        // Drizzle wraps the driver error, so the refusal is on the cause chain.
        .catch((error: unknown) => {
          const messages: string[] = [];
          let current = error;
          while (current instanceof Error) {
            messages.push(current.message);
            current = current.cause;
          }
          return messages.join(" | ");
        });

      expect(refusal).toContain("permission denied");
    });

    test("a worker holding a stale as-of loses to the one that already wrote", async () => {
      const sourceId = await seedCountedSource(5);
      const fresher = new Date(
        NOW.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS * 3,
      );
      // The winner stamps a fresh as-of first.
      await refreshForTest({ scopedDb, sourceId, now: fresher });

      // The loser started its cycle earlier and carries an older `now`. Its
      // compare-and-set matches no row, so it writes nothing rather than moving
      // the figure backwards.
      expect(await refreshForTest({ scopedDb, sourceId, now: NOW })).toBe(
        "fresh",
      );
      expect(await readStoredPair(sourceId)).toEqual({
        storedTotal: 5,
        storedTotalAsOf: fresher,
      });
    });

    test("a concurrent refresh cannot replace a count observed before its write", async () => {
      const sourceId = await seedCountedSource(2);
      const timestamp = { later: NOW };

      const result = await refreshForTest({
        scopedDb,
        sourceId,
        now: NOW,
        estimateSource: async (id) => {
          timestamp.later = await readEligibleDue(id);
          await refreshForTest({
            scopedDb,
            sourceId: id,
            now: timestamp.later,
          });
          return 1;
        },
      });

      expect(result).toBe("fresh");
      expect(await readStoredPair(sourceId)).toEqual({
        storedTotal: 2,
        storedTotalAsOf: timestamp.later,
      });
    });

    test("a failed attempt backs off at just under the interval and retries at its boundary", async () => {
      const sourceId = await seedCountedSource(0);
      let calls = 0;
      const estimateSource = async () => {
        calls += 1;
        throw Object.assign(new Error("statement timeout"), { code: "57014" });
      };
      expect(
        await refreshForTest({ scopedDb, sourceId, now: NOW, estimateSource }),
      ).toBe("unavailable");
      const attempted = (
        await db
          .select({ at: caseLawSources.storedTotalAttemptedAt })
          .from(caseLawSources)
          .where(eq(caseLawSources.id, sourceId))
          .limit(1)
      ).at(0)?.at;
      expect(attempted).toEqual(NOW);
      const due = await readEligibleDue(sourceId);
      expect(await readStoredPair(sourceId)).toEqual({
        storedTotal: null,
        storedTotalAsOf: null,
      });
      expect(
        await refreshForTest({
          scopedDb,
          sourceId,
          now: new Date(due.getTime() - 1),
          estimateSource,
        }),
      ).toBe("fresh");
      expect(calls).toBe(1);
      expect(
        await refreshForTest({
          scopedDb,
          sourceId,
          now: new Date(due),
          estimateSource,
        }),
      ).toBe("unavailable");
      expect(calls).toBe(2);
      expect(
        await refreshForTest({
          scopedDb,
          sourceId,
          now: new Date(due.getTime() + 1),
          estimateSource,
        }),
      ).toBe("fresh");
      expect(calls).toBe(2);
    });

    test("overlapping independent workers claim once before invoking the estimator", async () => {
      const sourceId = await seedCountedSource(0);
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const firstDb = openClient().db;
        const secondDb = openClient().db;
        const locker = await openClient().sql.reserve();
        await firstDb.execute(sql.raw(`SET search_path TO ${schema}, public`));
        await secondDb.execute(sql.raw(`SET search_path TO ${schema}, public`));
        const entered = [
          Promise.withResolvers<undefined>(),
          Promise.withResolvers<undefined>(),
        ];
        const firstEntered =
          entered[0] ?? panic("Missing first-worker barrier");
        const secondEntered =
          entered[1] ?? panic("Missing second-worker barrier");
        let firstTransactions = 0;
        let secondTransactions = 0;
        const firstScope: ScopedDb = async (callback) =>
          await firstDb.transaction(async (tx) => {
            if (firstTransactions++ === 0) {
              firstEntered.resolve(undefined);
            }
            return await callback(asTestRaw<Transaction>(tx));
          });
        const secondScope: ScopedDb = async (callback) =>
          await secondDb.transaction(async (tx) => {
            if (secondTransactions++ === 0) {
              secondEntered.resolve(undefined);
            }
            return await callback(asTestRaw<Transaction>(tx));
          });
        const firstPid = (
          await firstDb.execute(sql`SELECT pg_backend_pid() AS pid`)
        ).at(0)?.["pid"];
        const secondPid = (
          await secondDb.execute(sql`SELECT pg_backend_pid() AS pid`)
        ).at(0)?.["pid"];
        if (typeof firstPid !== "number" || typeof secondPid !== "number") {
          throw new TypeError("Expected PostgreSQL backend identifiers");
        }
        expect(firstPid).not.toBe(secondPid);
        await locker.unsafe("BEGIN");
        await locker.unsafe(
          `SELECT id FROM ${schema}.case_law_sources WHERE id = $1 FOR UPDATE`,
          [sourceId],
        );
        let calls = 0;
        const estimateSource = async () => {
          calls += 1;
          return 7;
        };
        const first = refreshForTest({
          scopedDb: firstScope,
          sourceId,
          now: NOW,
          estimateSource,
        });
        const second = refreshForTest({
          scopedDb: secondScope,
          sourceId,
          now: NOW,
          estimateSource,
        });
        try {
          await Promise.all([firstEntered.promise, secondEntered.promise]);
          // Observe both server-side waits before releasing the row: a
          // read-then-update mutation must have read the old row twice.
          const deadline = Date.now() + 3000;
          let bothBlocked = false;
          while (Date.now() < deadline) {
            // db-await-in-loop: bounded synchronization on actual backend lock waits.
            const row = (
              await locker.unsafe<{ blocked: boolean }[]>(
                "SELECT cardinality(pg_blocking_pids($1::int)) > 0 AND cardinality(pg_blocking_pids($2::int)) > 0 AS blocked",
                [firstPid, secondPid],
              )
            ).at(0);
            if (row?.blocked === true) {
              bothBlocked = true;
              break;
            }
            await Bun.sleep(10);
          }
          expect(bothBlocked).toBe(true);
          expect(calls).toBe(0);
        } finally {
          await locker.unsafe("COMMIT");
          locker.release();
        }
        expect((await Promise.all([first, second])).toSorted()).toEqual([
          "fresh",
          "refreshed",
        ]);
        expect(calls).toBe(1);
        expect(await readStoredPair(sourceId)).toEqual({
          storedTotal: 7,
          storedTotalAsOf: NOW,
        });
      });
    });

    test("a stale provider result cannot overwrite a newer attempt's estimate", async () => {
      const sourceId = await seedCountedSource(0);
      const barrier = Promise.withResolvers<undefined>();
      const started = Promise.withResolvers<undefined>();
      const first = refreshForTest({
        scopedDb,
        sourceId,
        now: NOW,
        estimateSource: async () => {
          started.resolve(undefined);
          await barrier.promise;
          return 11;
        },
      });

      await started.promise;
      const later = await readEligibleDue(sourceId);
      try {
        expect(
          await refreshForTest({
            scopedDb,
            sourceId,
            now: later,
            estimateSource: async () => 22,
          }),
        ).toBe("refreshed");
      } finally {
        barrier.resolve(undefined);
        expect(await first).toBe("fresh");
      }
      expect(await readStoredPair(sourceId)).toEqual({
        storedTotal: 22,
        storedTotalAsOf: later,
      });
    });

    test("recent pre-migration success and independent source freshness govern claims", async () => {
      const first = await seedCountedSource(0);
      const second = await seedCountedSource(0);
      await db
        .update(caseLawSources)
        .set({
          storedTotal: 10,
          storedTotalAsOf: NOW,
          storedTotalNextRefreshAt: null,
        })
        .where(eq(caseLawSources.id, first));
      const old = new Date(
        NOW.getTime() - SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS * 2,
      );
      await db
        .update(caseLawSources)
        .set({ storedTotal: 8, storedTotalAsOf: old })
        .where(eq(caseLawSources.id, second));
      let calls = 0;
      const estimateSource = async () => {
        calls += 1;
        return 20;
      };
      expect(
        await refreshForTest({
          scopedDb,
          sourceId: first,
          now: new Date(NOW.getTime() + 1),
          estimateSource,
        }),
      ).toBe("fresh");
      expect(calls).toBe(0);
      expect(await readEligibleDue(first)).toEqual(
        sourceStoredTotalNextRefreshAt(
          first,
          new Date(NOW.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS),
        ),
      );
      expect(await readStoredPair(second)).toEqual({
        storedTotal: 8,
        storedTotalAsOf: old,
      });
      expect(
        (
          await db
            .select({ at: caseLawSources.storedTotalAttemptedAt })
            .from(caseLawSources)
            .where(eq(caseLawSources.id, second))
            .limit(1)
        ).at(0)?.at,
      ).toBeNull();
      expect(
        await refreshForTest({
          scopedDb,
          sourceId: second,
          now: new Date(NOW.getTime() + 1),
          estimateSource,
        }),
      ).toBe("refreshed");
      expect(calls).toBe(1);
      expect(await readStoredPair(first)).toEqual({
        storedTotal: 10,
        storedTotalAsOf: NOW,
      });
      expect(await readStoredPair(second)).toEqual({
        storedTotal: 20,
        storedTotalAsOf: new Date(NOW.getTime() + 1),
      });
    });

    test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
      "invalid estimate %s preserves the last pair and durable backoff",
      async (value) => {
        const sourceId = await seedCountedSource(0);
        await db
          .update(caseLawSources)
          .set({ storedTotal: 3, storedTotalAsOf: NOW })
          .where(eq(caseLawSources.id, sourceId));
        const attemptedAt = new Date(
          NOW.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
        );
        await setDue(sourceId, attemptedAt);
        let calls = 0;
        const estimateSource = async () => {
          calls += 1;
          return value;
        };
        expect(
          await refreshForTest({
            scopedDb,
            sourceId,
            now: attemptedAt,
            estimateSource,
          }),
        ).toBe("unavailable");
        expect(
          await refreshForTest({
            scopedDb,
            sourceId,
            now: new Date(attemptedAt.getTime() + 1),
            estimateSource,
          }),
        ).toBe("fresh");
        expect(calls).toBe(1);
        expect(await readStoredPair(sourceId)).toEqual({
          storedTotal: 3,
          storedTotalAsOf: NOW,
        });
        expect(
          (
            await db
              .select({ at: caseLawSources.storedTotalAttemptedAt })
              .from(caseLawSources)
              .where(eq(caseLawSources.id, sourceId))
              .limit(1)
          ).at(0)?.at,
        ).toEqual(attemptedAt);
      },
    );

    test("production estimates track insert, delete, source reassignment and replay after ANALYZE", async () => {
      const first = await seedCountedSource(600);
      const second = await seedCountedSource(200);
      const ingestionDb = markRlsDatabase({
        transaction: async <T>(
          fn: (tx: TransactionOf<typeof db>) => Promise<T>,
        ): Promise<T> => await db.transaction(fn),
      });
      let calls = 0;
      const estimateSource = async (sourceId: SafeId<"caseLawSource">) => {
        calls += 1;
        const estimate = await estimateSourceThroughIngestionRole(
          ingestionDb,
          sourceId,
        );
        const producer = await ingestionScopedDb(async (tx) =>
          explainRoot(
            await tx.execute(explainSourceStoredTotalQuery(sourceId)),
          ),
        );
        expect(estimate).toBe(producer["Plan Rows"]);
        return estimate;
      };
      const assertEstimate = async (
        sourceId: SafeId<"caseLawSource">,
        expected: number,
      ) => {
        const row = await readStoredPair(sourceId);
        expect(row?.storedTotal).toBeGreaterThan(expected - 20);
        expect(row?.storedTotal).toBeLessThan(expected + 20);
      };
      await db.execute(sql`ANALYZE case_law_decisions`);
      expect(
        await refreshForTest({
          scopedDb,
          sourceId: first,
          now: NOW,
          estimateSource,
        }),
      ).toBe("refreshed");
      expect(
        await refreshForTest({
          scopedDb,
          sourceId: second,
          now: NOW,
          estimateSource,
        }),
      ).toBe("refreshed");
      await assertEstimate(first, 600);
      await assertEstimate(second, 200);
      const deleted = await db
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, first))
        .limit(100);
      await db.delete(caseLawDecisions).where(
        inArray(
          caseLawDecisions.id,
          deleted.map(({ id }) => id),
        ),
      );
      const reassigned = await db
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, first))
        .limit(100);
      await db
        .update(caseLawDecisions)
        .set({ sourceId: second })
        .where(
          inArray(
            caseLawDecisions.id,
            reassigned.map(({ id }) => id),
          ),
        );
      await db.execute(sql`ANALYZE case_law_decisions`);
      const later = await readEligibleDue(first);
      expect(
        await refreshForTest({
          scopedDb,
          sourceId: first,
          now: later,
          estimateSource,
        }),
      ).toBe("refreshed");
      expect(
        await refreshForTest({
          scopedDb,
          sourceId: second,
          now: await readEligibleDue(second),
          estimateSource,
        }),
      ).toBe("refreshed");
      await assertEstimate(first, 400);
      await assertEstimate(second, 300);
      expect(
        await refreshForTest({
          scopedDb,
          sourceId: first,
          now: later,
          estimateSource,
        }),
      ).toBe("fresh");
      expect(calls).toBe(4);
      await assertEstimate(first, 400);
    });
    test("an old successful estimate cannot write after a newer failed attempt", async () => {
      const sourceId = await seedCountedSource(0);
      const originalAsOf = new Date(
        NOW.getTime() - SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
      );
      await db
        .update(caseLawSources)
        .set({ storedTotal: 3, storedTotalAsOf: originalAsOf })
        .where(eq(caseLawSources.id, sourceId));
      const barrier = Promise.withResolvers<undefined>();
      const started = Promise.withResolvers<undefined>();
      const old = refreshForTest({
        scopedDb,
        sourceId,
        now: NOW,
        estimateSource: async () => {
          started.resolve(undefined);
          await barrier.promise;
          return 11;
        },
      });

      await started.promise;
      const newer = await readEligibleDue(sourceId);
      try {
        expect(
          await refreshForTest({
            scopedDb,
            sourceId,
            now: newer,
            estimateSource: async () => {
              throw Object.assign(new Error("new attempt timed out"), {
                code: "57014",
              });
            },
          }),
        ).toBe("unavailable");
      } finally {
        barrier.resolve(undefined);
        expect(await old).toBe("fresh");
      }
      expect(await readStoredPair(sourceId)).toEqual({
        storedTotal: 3,
        storedTotalAsOf: originalAsOf,
      });
      expect(
        (
          await db
            .select({ at: caseLawSources.storedTotalAttemptedAt })
            .from(caseLawSources)
            .where(eq(caseLawSources.id, sourceId))
            .limit(1)
        ).at(0)?.at,
      ).toEqual(newer);
    });

    test("first unmeasured observation is immediately admitted at its most recent source phase", async () => {
      const sourceId = await seedCountedSource(0);
      await db
        .update(caseLawSources)
        .set({ storedTotalNextRefreshAt: null })
        .where(eq(caseLawSources.id, sourceId));
      let admissions = 0;
      let estimates = 0;
      expect(
        await refreshForTest({
          scopedDb,
          sourceId,
          now: NOW,
          acquireAdmission: async () => {
            admissions += 1;
            expect(await readScheduledDue(sourceId)).toEqual(
              sourceStoredTotalNextRefreshAt(
                sourceId,
                new Date(
                  NOW.getTime() - SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS + 1,
                ),
              ),
            );
            return "granted";
          },
          estimateSource: async () => {
            estimates += 1;
            return 9;
          },
        }),
      ).toBe("refreshed");
      expect(admissions).toBe(1);
      expect(estimates).toBe(1);
      expect(await readScheduledDue(sourceId)).toEqual(
        sourceStoredTotalNextRefreshAt(
          sourceId,
          new Date(NOW.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS),
        ),
      );
      expect(await readStoredPair(sourceId)).toEqual({
        storedTotal: 9,
        storedTotalAsOf: NOW,
      });
    });

    test("due work commits its attempt before admission and estimates only after grant", async () => {
      const sourceId = await seedCountedSource(0);
      const admission = Promise.withResolvers<"granted" | "held">();
      const entered = Promise.withResolvers<undefined>();
      let estimates = 0;
      const refresh = refreshForTest({
        scopedDb,
        sourceId,
        now: NOW,
        acquireAdmission: async () => {
          entered.resolve(undefined);
          return await admission.promise;
        },
        estimateSource: async () => {
          estimates += 1;
          return 9;
        },
      });
      try {
        await entered.promise;
        expect(estimates).toBe(0);
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const observer = openClient().db;
          await observer.execute(
            sql.raw(`SET search_path TO ${schema}, public`),
          );
          const observed = (
            await observer
              .select({
                attempted: caseLawSources.storedTotalAttemptedAt,
                due: caseLawSources.storedTotalNextRefreshAt,
              })
              .from(caseLawSources)
              .where(eq(caseLawSources.id, sourceId))
              .limit(1)
          ).at(0);
          expect(observed?.attempted).toEqual(NOW);
          expect(observed?.due).toEqual(NOW);
        });
      } finally {
        admission.resolve("granted");
      }
      expect(await refresh).toBe("refreshed");
      expect(estimates).toBe(1);
      expect(await readScheduledDue(sourceId)).toEqual(
        sourceStoredTotalNextRefreshAt(
          sourceId,
          new Date(NOW.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS),
        ),
      );
    });

    test("held admission restores the original attempt and due slot for immediate retry", async () => {
      const sourceId = await seedCountedSource(0);
      const previous = new Date(
        NOW.getTime() - SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS * 2,
      );
      await db
        .update(caseLawSources)
        .set({
          storedTotal: 3,
          storedTotalAsOf: previous,
          storedTotalAttemptedAt: previous,
        })
        .where(eq(caseLawSources.id, sourceId));
      let estimates = 0;
      expect(
        await refreshForTest({
          scopedDb,
          sourceId,
          now: NOW,
          acquireAdmission: async () => "held",
          estimateSource: async () => {
            estimates += 1;
            return 9;
          },
        }),
      ).toBe("held");
      expect(await readStoredPair(sourceId)).toEqual({
        storedTotal: 3,
        storedTotalAsOf: previous,
      });
      expect(await readScheduledDue(sourceId)).toEqual(NOW);
      expect(
        (
          await db
            .select({ at: caseLawSources.storedTotalAttemptedAt })
            .from(caseLawSources)
            .where(eq(caseLawSources.id, sourceId))
            .limit(1)
        ).at(0)?.at,
      ).toEqual(previous);
      expect(estimates).toBe(0);
      const reopened = new Date(NOW.getTime() + 1);
      expect(
        await refreshForTest({
          scopedDb,
          sourceId,
          now: reopened,
          acquireAdmission: async () => "granted",
          estimateSource: async () => {
            estimates += 1;
            return 9;
          },
        }),
      ).toBe("refreshed");
      expect(estimates).toBe(1);
      expect(await readStoredPair(sourceId)).toEqual({
        storedTotal: 9,
        storedTotalAsOf: reopened,
      });
    });

    test("very overdue work is refreshed without skipping its source", async () => {
      const sourceId = await seedCountedSource(0);
      let admissions = 0;
      const late = new Date(
        NOW.getTime() + 4 * SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
      );
      expect(
        await refreshForTest({
          scopedDb,
          sourceId,
          now: late,
          acquireAdmission: async () => {
            admissions += 1;
            return "granted";
          },
          estimateSource: async () => 9,
        }),
      ).toBe("refreshed");
      expect(admissions).toBe(1);
      expect(await readStoredPair(sourceId)).toEqual({
        storedTotal: 9,
        storedTotalAsOf: late,
      });
      expect(await readScheduledDue(sourceId)).toEqual(
        sourceStoredTotalNextRefreshAt(
          sourceId,
          new Date(late.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS),
        ),
      );
    });

    test("most-overdue source phases drain one per cycle in order across hold and restart", async () => {
      // This schema belongs to this suite; remove earlier fixtures from this queue.
      await db
        .update(caseLawSources)
        .set({
          storedTotalNextRefreshAt: new Date(
            NOW.getTime() + 10 * SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
          ),
        })
        .where(sql`true`);
      const unsorted = Array.from({ length: 24 }, (_, index) => {
        const id = toSafeId<"caseLawSource">(
          `0198e331-e578-7000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
        );
        const phase = sourceStoredTotalNextRefreshAt(
          id,
          new Date(NOW.getTime() - SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS + 1),
        );
        return {
          id,
          due: new Date(
            phase.getTime() - 3 * SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
          ),
        };
      });
      const tied = new Date(
        Math.min(...unsorted.map(({ due }) => due.getTime())),
      );
      const entries = unsorted
        .map((entry, index) =>
          index < 2 ? { id: entry.id, due: tied } : entry,
        )
        .toSorted((left, right) => {
          const difference = left.due.getTime() - right.due.getTime();
          if (difference !== 0) {
            return difference;
          }
          if (left.id === right.id) {
            return 0;
          }
          return left.id < right.id ? -1 : 1;
        });
      expect(
        new Set(entries.map(({ due }) => Math.floor(due.getTime() / 3_600_000)))
          .size,
      ).toBeGreaterThan(1);
      const previous = new Date(
        NOW.getTime() - 5 * SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
      );
      await db.insert(caseLawSources).values(
        entries.toReversed().map(({ id, due }) => ({
          id,
          adapterKey: `phased-${id}`,
          name: "Phased source",
          storedTotalNextRefreshAt: due,
          storedTotalAttemptedAt: previous,
        })),
      );
      const oldest = entries.at(0) ?? panic("Missing oldest source");
      const estimated: SafeId<"caseLawSource">[] = [];
      let admissions = 0;
      const estimateSource = async (sourceId: SafeId<"caseLawSource">) => {
        estimated.push(sourceId);
        return 9;
      };
      expect(
        await refreshNextSourceStoredTotal({
          scopedDb,
          now: NOW,
          acquireAdmission: async () => {
            admissions += 1;
            return "held";
          },
          estimateSource,
        }),
      ).toBe("held");
      expect(estimated).toEqual([]);
      expect(await readScheduledDue(oldest.id)).toEqual(oldest.due);
      expect(
        (
          await db
            .select({ at: caseLawSources.storedTotalAttemptedAt })
            .from(caseLawSources)
            .where(eq(caseLawSources.id, oldest.id))
            .limit(1)
        ).at(0)?.at,
      ).toEqual(previous);
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const restartedDb = openClient().db;
        await restartedDb.execute(
          sql.raw(`SET search_path TO ${schema}, public`),
        );
        const restartScope: ScopedDb = async (callback) =>
          await restartedDb.transaction(
            async (tx) => await callback(asTestRaw<Transaction>(tx)),
          );
        const acquireAdmission = async () => {
          admissions += 1;
          return "granted" as const;
        };
        for (const expected of entries) {
          const before = estimated.length;
          // db-await-in-loop: a bounded 24-source matrix proves each cycle drains exactly one durable overdue source.
          expect(
            await refreshNextSourceStoredTotal({
              scopedDb: restartScope,
              now: NOW,
              acquireAdmission,
              estimateSource,
            }),
          ).toBe("refreshed");
          expect(estimated.length).toBe(before + 1);
          expect(estimated.at(-1)).toBe(expected.id);
          // db-await-in-loop: verify each processed source advances only its own durable fixed phase.
          expect(await readScheduledDue(expected.id)).toEqual(
            sourceStoredTotalNextRefreshAt(
              expected.id,
              new Date(NOW.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS),
            ),
          );
        }
        expect(
          await refreshNextSourceStoredTotal({
            scopedDb: restartScope,
            now: NOW,
            acquireAdmission: async () => {
              admissions += 1;
              return "granted";
            },
            estimateSource,
          }),
        ).toBe("fresh");
      });
      expect(estimated).toEqual(entries.map(({ id }) => id));
      expect(admissions).toBe(entries.length + 1);
    });
    test("an admission exception preserves the pair and backs off without estimating", async () => {
      const sourceId = await seedCountedSource(0);
      const previous = new Date(
        NOW.getTime() - SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS,
      );
      await db
        .update(caseLawSources)
        .set({ storedTotal: 3, storedTotalAsOf: previous })
        .where(eq(caseLawSources.id, sourceId));
      let admissions = 0;
      let estimates = 0;
      const acquireAdmission = async () => {
        admissions += 1;
        throw Object.assign(new Error("budget admission failed"), {
          code: "57014",
        });
      };
      const estimateSource = async () => {
        estimates += 1;
        return 9;
      };
      expect(
        await refreshForTest({
          scopedDb,
          sourceId,
          now: NOW,
          acquireAdmission,
          estimateSource,
        }),
      ).toBe("unavailable");
      expect(await readStoredPair(sourceId)).toEqual({
        storedTotal: 3,
        storedTotalAsOf: previous,
      });
      expect(await readScheduledDue(sourceId)).toEqual(
        sourceStoredTotalNextRefreshAt(
          sourceId,
          new Date(NOW.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS),
        ),
      );
      expect(await readEligibleDue(sourceId)).toEqual(
        sourceStoredTotalNextRefreshAt(
          sourceId,
          new Date(NOW.getTime() + SOURCE_STORED_TOTAL_REFRESH_INTERVAL_MS),
        ),
      );
      expect(
        await refreshForTest({
          scopedDb,
          sourceId,
          now: new Date(NOW.getTime() + 1),
          acquireAdmission,
          estimateSource,
        }),
      ).toBe("fresh");
      expect(admissions).toBe(1);
      expect(estimates).toBe(0);
    });
  },
);
