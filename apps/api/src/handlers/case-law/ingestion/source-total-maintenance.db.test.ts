import { panic, Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { defaultConfig } from "@stll/db-load-gate/health";

import {
  CORPUS_SCHEMA_LANE_LOCK_SQL,
  CORPUS_SCHEMA_LANE_UNLOCK_SQL,
} from "@/api/db/corpus-schema-lane";
import {
  caseLawDecisions,
  caseLawIngestionEvents,
  caseLawSources,
} from "@/api/db/schema";
import { createIngestionDb, markRlsDatabase } from "@/api/db/scoped";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import { createSafeId } from "@/api/lib/branded-types";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import {
  remainingCycleMs,
  startCycleDeadline,
} from "@/api/lib/legal-search/cycle-deadline";
import { logger } from "@/api/lib/observability/logger";
import { withFreshIndicatorDatabase } from "@/api/tests/database-load-indicator-fixture";
import {
  copyIngestionTablePrivileges,
  withGatedTestClients,
  type GatedTestDb,
} from "@/api/tests/gated-test-database";

import { czNsAdapter } from "./adapters/cz-ns";
import { runIngestionPipeline } from "./pipeline";
import { createSourceStoredTotalAdmission } from "./source-total-admission";
import {
  countSourceThroughIngestionRole,
  createSourceStoredTotalMaintenanceRuntime,
  refreshSourceStoredTotal,
} from "./source-totals";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

// Generate the fixture from the actual owning table declarations, including
// their constraints and policies; the load function comes from its migration.
const installCorpusTables = async (
  db: GatedTestDb,
  sourceDatabaseUrl: string,
) => {
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  const { generateDrizzleJson, generateMigration } =
    await import("drizzle-kit/api-postgres");
  const empty = await generateDrizzleJson({});
  const corpus = await generateDrizzleJson({
    caseLawSources,
    caseLawDecisions,
    caseLawIngestionEvents,
  });
  const sqlStatements = await generateMigration(empty, corpus);
  for (const statement of sqlStatements) {
    // db-await-in-loop: canonical generated statements have ordered foreign-key dependencies.
    await db.execute(sql.raw(statement));
  }
  await withGatedTestClients(sourceDatabaseUrl, async ({ openClient }) => {
    await copyIngestionTablePrivileges({
      sourceDb: openClient().db,
      targetDb: db,
      targetSchema: "public",
      tableNames: [
        "case_law_sources",
        "case_law_decisions",
        "case_law_ingestion_events",
      ],
    });
  });
  const refreshColumns = [
    caseLawSources.storedTotalAttemptedAt,
    caseLawSources.storedTotalNextRefreshAt,
    caseLawSources.storedTotalHeldSince,
    caseLawSources.storedTotalWarnedSlot,
  ];
  const refreshGrant = (
    await db.execute(sql`SELECT bool_and(
    has_column_privilege('stella_ingestion', 'public.case_law_sources', column_name, 'UPDATE')
  ) AS granted FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'case_law_sources'
      AND column_name IN (${sql.join(
        refreshColumns.map((column) => sql`${column.name}`),
        sql`, `,
      )})`)
  ).at(0);
  if (refreshGrant?.["granted"] !== true) {
    // The host can predate these columns; the fresh database already has their canonical DDL.
    const migration = await Bun.file(
      new URL(
        "../../../../drizzle/20261003123500_case_law_source_stored_total_attempt/migration.sql",
        import.meta.url,
      ),
    ).text();
    const grant = migration
      .split("--> statement-breakpoint")
      .find((statement) => statement.trim().startsWith("GRANT UPDATE ("));
    if (grant === undefined) {
      return panic(
        "The stored-total refresh migration must own its column grant",
      );
    }
    // Only this disposable database receives the exact owning migration's new-column grant.
    await db.execute(sql.raw(grant));
  }
};

const seedSource = async (db: GatedTestDb) => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: ADAPTER_KEYS.CZ_NS,
    name: "Stored-total maintenance fixture",
    storedTotal: 77,
    storedTotalAsOf: new Date("2020-01-01T00:00:00Z"),
    storedTotalNextRefreshAt: new Date(0),
  });
  return sourceId;
};

describe.skipIf(!enabled)(
  "production stored-total admission composition",
  () => {
    if (databaseUrl === undefined) {
      if (enabled) {
        panic("Stored-total maintenance PostgreSQL tests require DATABASE_URL");
      }
      return;
    }
    const url = databaseUrl;

    test("initial indicator admission aborts while the real schema lane remains exclusive", async () => {
      await withFreshIndicatorDatabase(url, async ({ client, db }) => {
        await installCorpusTables(db, url);
        const scopedDb = createIngestionDb(markRlsDatabase(db));
        const holder = await client.reserve();
        const maintenance = createSourceStoredTotalMaintenanceRuntime(
          scopedDb,
          {
            config: { ...defaultConfig, busyWindows: [] },
            readEbsSignal: async () => ({
              indicator: "ebs_balance",
              kind: "normal",
              value: 100,
              threshold: 70,
              observedAt: new Date().toISOString(),
              reason: "External EBS fixture",
            }),
          },
        );
        try {
          await holder.unsafe(CORPUS_SCHEMA_LANE_LOCK_SQL);
          const deadline = startCycleDeadline({
            budgetMs: 135_000,
            abortEarlyOn: [AbortSignal.timeout(100)],
          });
          const started = Date.now();
          const admission = await maintenance.acquireAdmission({ deadline });
          expect(Date.now() - started).toBeLessThan(5000);
          expect(admission).not.toBe("granted");
          expect(deadline.signal.aborted).toBe(true);
          // No reservation was committed and the exclusive holder is still live.
          expect(remainingCycleMs(deadline)).toBeGreaterThan(130_000);
        } finally {
          await holder.unsafe(CORPUS_SCHEMA_LANE_UNLOCK_SQL);
          holder.release();
        }
      });
    }, 60_000);

    test("the restricted SQL boundary rechecks load after the durable claim and connection setup", async () => {
      await withFreshIndicatorDatabase(url, async ({ db }) => {
        await installCorpusTables(db, url);
        const sourceId = await seedSource(db);
        const scopedDb = createIngestionDb(markRlsDatabase(db));
        const deadline = startCycleDeadline({ budgetMs: 135_000 });
        let stopped = false;
        const admit = createSourceStoredTotalAdmission({
          readVerdict: async () => ({
            kind: stopped ? "stop" : "normal",
            signals: [],
          }),
        });
        const result = await refreshSourceStoredTotal({
          scopedDb,
          sourceId,
          deadline,
          acquireAdmission: async (phase) =>
            await admit({
              deadline,
              ...(phase === undefined ? {} : { phase }),
            }),
          countSource: async (id, options) => {
            // A query against this deliberately removed relation would fail.
            // Returning HELD therefore proves validation precedes the real SQL.
            await db.execute(sql`DROP TABLE case_law_decisions`);
            stopped = true;
            return await countSourceThroughIngestionRole({
              database: markRlsDatabase(db),
              sourceId: id,
              ...options,
            });
          },
        });
        expect(result).toBe("held");
        const row = (
          await db
            .select()
            .from(caseLawSources)
            .where(eq(caseLawSources.id, sourceId))
        ).at(0);
        expect(row?.storedTotal).toBe(77);
        expect(row?.storedTotalAsOf).toEqual(new Date("2020-01-01T00:00:00Z"));
        expect(row?.storedTotalAttemptedAt).toBeInstanceOf(Date);
        expect(row?.storedTotalNextRefreshAt?.getTime()).toBeGreaterThan(
          Date.now(),
        );
      });
    }, 60_000);

    for (const failure of ["missing", "no-execute", "blind-owner"] as const) {
      test(`${failure} indicators hold real pipeline work until visibility returns`, async () => {
        await withFreshIndicatorDatabase(
          url,
          async ({ client, db, migration, unrelatedRole }) => {
            await installCorpusTables(db, url);
            const sourceId = await seedSource(db);
            const scopedDb = createIngestionDb(markRlsDatabase(db));
            const maintenance = createSourceStoredTotalMaintenanceRuntime(
              scopedDb,
              {
                config: { ...defaultConfig, busyWindows: [] },
                readEbsSignal: async () => ({
                  indicator: "ebs_balance",
                  kind: "normal",
                  value: 100,
                  threshold: 70,
                  observedAt: new Date().toISOString(),
                  reason: "External EBS fixture",
                }),
              },
            );
            const owner = (await client`SELECT current_user AS owner`).at(0)?.[
              "owner"
            ];
            if (typeof owner !== "string") {
              return panic("Fixture login omitted its role name");
            }
            const quotedOwner = `"${owner.replaceAll('"', '""')}"`;
            switch (failure) {
              case "missing":
                await client`DROP FUNCTION public.stella_database_load_indicators(regclass)`;
                break;
              case "no-execute":
                await client`REVOKE EXECUTE ON FUNCTION public.stella_database_load_indicators(regclass) FROM stella_ingestion`;
                break;
              case "blind-owner":
                await client.unsafe(
                  `ALTER FUNCTION public.stella_database_load_indicators(regclass) OWNER TO ${unrelatedRole}`,
                );
                break;
            }
            const fetchPage = czNsAdapter.fetchPage;
            const warnings = spyOn(logger, "warn");
            let counts = 0;
            czNsAdapter.fetchPage = async () =>
              Result.ok({ decisions: [], nextCursor: null });
            const run = async () => {
              const lease = await acquireCaseLawSourceIngestionLease({
                scopedDb,
                sourceId,
              });
              if (lease === null) {
                return panic("Fixture source lease was unavailable");
              }
              try {
                await runIngestionPipeline({
                  scopedDb,
                  source: lease.source,
                  sourceLease: lease,
                  cycle: { budgetMs: 300_000 },
                  acquireStoredTotalAdmission: maintenance.acquireAdmission,
                  countStoredTotalSource: async (id, options) => {
                    counts += 1;
                    return await countSourceThroughIngestionRole({
                      database: markRlsDatabase(db),
                      sourceId: id,
                      ...options,
                    });
                  },
                });
              } finally {
                await lease.release();
              }
            };
            try {
              await run();
              await run();
              expect(counts).toBe(0);
              const held = (
                await db
                  .select()
                  .from(caseLawSources)
                  .where(eq(caseLawSources.id, sourceId))
              ).at(0);
              expect(held?.storedTotal).toBe(77);
              expect(held?.storedTotalAsOf).toEqual(
                new Date("2020-01-01T00:00:00Z"),
              );
              expect(held?.storedTotalAttemptedAt).toBeNull();
              expect(held?.storedTotalNextRefreshAt).toEqual(new Date(0));
              expect(held?.storedTotalHeldSince).toBeInstanceOf(Date);
              expect(held?.storedTotalWarnedSlot).toEqual(new Date(0));
              expect(
                warnings.mock.calls.filter(
                  ([event]) =>
                    event === "case_law.source_stored_total.held_unknown",
                ),
              ).toHaveLength(1);
              switch (failure) {
                case "missing":
                  await client.begin(async (tx) => {
                    for (const statement of migration.split(
                      "--> statement-breakpoint",
                    )) {
                      if (statement.trim().length > 0) {
                        await tx.unsafe(statement);
                      }
                    }
                  });
                  break;
                case "no-execute":
                  await client`GRANT EXECUTE ON FUNCTION public.stella_database_load_indicators(regclass) TO stella_ingestion`;
                  break;
                case "blind-owner":
                  await client.unsafe(
                    `ALTER FUNCTION public.stella_database_load_indicators(regclass) OWNER TO ${quotedOwner}`,
                  );
                  break;
              }
              await run();
              expect(counts).toBe(1);
              const restored = (
                await db
                  .select()
                  .from(caseLawSources)
                  .where(eq(caseLawSources.id, sourceId))
              ).at(0);
              expect(restored?.storedTotal).toBe(0);
              expect(restored?.storedTotalAsOf).toBeInstanceOf(Date);
              expect(restored?.storedTotalAttemptedAt).toBeInstanceOf(Date);
              expect(restored?.storedTotalHeldSince).toBeNull();
            } finally {
              czNsAdapter.fetchPage = fetchPage;
              warnings.mockRestore();
            }
          },
        );
      }, 60_000);
    }

    for (const transition of ["expire", "abort", "stop"] as const) {
      test(`a reserved count cannot start after ${transition} while the actual schema lane is held`, async () => {
        await withFreshIndicatorDatabase(url, async ({ client, db }) => {
          await installCorpusTables(db, url);
          const sourceId = await seedSource(db);
          const scopedDb = createIngestionDb(markRlsDatabase(db));
          const holder = await client.reserve();
          const reserved = Promise.withResolvers<undefined>();
          const releaseAdmission = Promise.withResolvers<undefined>();
          const controller = new AbortController();
          const monotonic = spyOn(performance, "now");
          const startedAt = performance.now();
          const deadline = startCycleDeadline({
            budgetMs: 135_000,
            abortEarlyOn: [controller.signal],
          });
          let stopped = false;
          let counts = 0;
          const admit = createSourceStoredTotalAdmission({
            readVerdict: async () => ({
              kind: stopped ? "stop" : "normal",
              signals: [],
            }),
          });
          try {
            const refresh = refreshSourceStoredTotal({
              scopedDb,
              sourceId,
              deadline,
              acquireAdmission: async (phase) => {
                const admitted = await admit({
                  deadline,
                  ...(phase === undefined ? {} : { phase }),
                });
                if (phase === undefined && admitted === "granted") {
                  await holder.unsafe(CORPUS_SCHEMA_LANE_LOCK_SQL);
                  reserved.resolve(undefined);
                  await releaseAdmission.promise;
                }
                return admitted;
              },
              countSource: async (id, options) => {
                counts += 1;
                return await countSourceThroughIngestionRole({
                  database: markRlsDatabase(db),
                  sourceId: id,
                  ...options,
                });
              },
            });
            await reserved.promise;
            expect(remainingCycleMs(deadline)).toBeLessThanOrEqual(5000);
            switch (transition) {
              case "expire":
                monotonic.mockReturnValue(startedAt + 135_001);
                break;
              case "abort":
                controller.abort();
                break;
              case "stop":
                stopped = true;
                break;
            }
            const returnedAt = Date.now();
            releaseAdmission.resolve(undefined);
            // STOP is checked after acquiring the real lane; expiration and abort
            // must return while it remains locked, rather than its 20-minute default.
            if (transition === "stop") {
              await holder.unsafe(CORPUS_SCHEMA_LANE_UNLOCK_SQL);
            }
            expect(await refresh).toBe("held");
            expect(Date.now() - returnedAt).toBeLessThan(5000);
            expect(counts).toBe(0);
            const row = (
              await db
                .select()
                .from(caseLawSources)
                .where(eq(caseLawSources.id, sourceId))
            ).at(0);
            expect(row?.storedTotal).toBe(77);
            expect(row?.storedTotalAsOf).toEqual(
              new Date("2020-01-01T00:00:00Z"),
            );
            expect(row?.storedTotalAttemptedAt).toBeNull();
            expect(row?.storedTotalNextRefreshAt).toEqual(new Date(0));
          } finally {
            monotonic.mockRestore();
            releaseAdmission.resolve(undefined);
            await holder.unsafe(CORPUS_SCHEMA_LANE_UNLOCK_SQL);
            holder.release();
          }
        });
      }, 60_000);
    }
  },
);
