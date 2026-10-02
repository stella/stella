import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";

import type { Verdict } from "@stll/db-load-gate/health";
import { createHeavyWorkSlot } from "@stll/db-load-gate/slot";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawReplayBatches,
  caseLawReplayDailyRows,
  caseLawReplayBlocked,
  caseLawSources,
  databaseBackfillStates,
} from "@/api/db/schema";
import {
  EMPTY_AST,
  STORED_RAW_REPARSE_REJECTION,
} from "@/api/handlers/case-law/ingestion/adapter";
import { getAdapter } from "@/api/handlers/case-law/ingestion/adapters/adapter-registry";
import type {
  BackgroundReplayBatch,
  BackgroundReplaySource,
} from "@/api/handlers/case-law/ingestion/background-replay";
import { createBackgroundReplayRunner } from "@/api/handlers/case-law/ingestion/background-replay-runner";
import { createBackgroundReplayStore } from "@/api/handlers/case-law/ingestion/background-replay-store";
import {
  REPLAY_ROW_OUTCOME,
  replayCaseLawSource,
  selectScopeEnd,
} from "@/api/handlers/case-law/ingestion/replay";
import { REPLAY_ENROLMENT } from "@/api/handlers/case-law/ingestion/replay-enrolment";
import { createSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import { acquireCaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import {
  withGatedTestClients,
  openGatedTestDatabase,
} from "@/api/tests/gated-test-database";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const verdict = () => ({ kind: "normal", signals: [] }) satisfies Verdict;

if (!databaseUrl || !enabled) {
  describe.skip("durable background replay reservations", () => {
    test("requires an explicitly enabled Postgres database", () =>
      expect(enabled && Boolean(databaseUrl)).toBe(false));
  });
} else {
  describe("durable background replay reservations", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(callback);
    const sources: BackgroundReplaySource[] = [];
    cleanUp(async () => {
      for (const source of sources) {
        await db
          .delete(caseLawReplayBlocked)
          .where(eq(caseLawReplayBlocked.sourceId, source.id));
        await db
          .delete(caseLawReplayDailyRows)
          .where(eq(caseLawReplayDailyRows.sourceId, source.id));
        await db
          .delete(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.sourceId, source.id));
        await db
          .delete(databaseBackfillStates)
          .where(
            eq(
              databaseBackfillStates.name,
              `case-law-replay:${source.id}:${source.currentParserVersion}`,
            ),
          );
        await db.delete(caseLawSources).where(eq(caseLawSources.id, source.id));
      }
    });
    const fixture = async (dailyBudget: number) => {
      const source = {
        id: createSafeId<"caseLawSource">(),
        adapterKey: ADAPTER_KEYS.EU_ECJ,
        currentParserVersion: 2,
        dailyBudget,
        mode: "enrolled",
        rowsBehind: 3,
        oldestAgeMs: 1,
        blockedCount: 0,
      } as const satisfies BackgroundReplaySource;
      sources.push(source);
      await db.insert(caseLawSources).values({
        id: source.id,
        adapterKey: `store-${source.id}`,
        name: "replay store fixture",
      });
      const ids = Array.from({ length: 3 }, () =>
        createSafeId<"caseLawDecision">(),
      ).toSorted();
      await db.insert(caseLawDecisions).values(
        ids.map((id, index) => ({
          id,
          sourceId: source.id,
          caseNumber: `store-${index}`,
          court: "fixture court",
          country: "CZE",
          language: "cs",
          parserVersion: 1,
          sourceRawS3Key: `fixture/${id}`,
        })),
      );
      const store = createBackgroundReplayStore({
        db,
        now: () => Date.UTC(2026, 9, 1),
      });
      return { source, ids, store };
    };
    const applied = (batch: BackgroundReplayBatch) => ({
      report: {
        id: batch.decisionId,
        caseNumber: "fixture",
        language: "cs",
        outcome: REPLAY_ROW_OUTCOME.APPLIED,
      },
      durationMs: 4,
      verdict: verdict(),
    });

    test("largest enabled lag yields to a smaller source after its daily budget is spent", async () => {
      const eu = await fixture(1);
      const cz = await fixture(1);
      await db
        .update(caseLawSources)
        .set({ adapterKey: ADAPTER_KEYS.EU_ECJ })
        .where(eq(caseLawSources.id, eu.source.id));
      await db
        .update(caseLawSources)
        .set({ adapterKey: ADAPTER_KEYS.CZ_NSS })
        .where(eq(caseLawSources.id, cz.source.id));
      const euVersion = PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ];
      const czVersion = PARSER_VERSIONS[ADAPTER_KEYS.CZ_NSS];
      await db
        .update(caseLawDecisions)
        .set({ parserVersion: czVersion })
        .where(inArray(caseLawDecisions.id, cz.ids.slice(1)));
      const blockedId = eu.ids.at(0);
      if (!blockedId) {
        throw new TypeError("Expected blocked lag fixture");
      }
      await db.insert(caseLawReplayBlocked).values({
        sourceId: eu.source.id,
        decisionId: blockedId,
        parserVersionFrom: 1,
        parserVersionTo: euVersion,
        reason: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
      });
      const enrolment = {
        ...REPLAY_ENROLMENT,
        [ADAPTER_KEYS.EU_ECJ]: {
          mode: "enrolled",
          dailyBudget: 1,
          reviewedDryRun: "fixture",
        },
        [ADAPTER_KEYS.CZ_NSS]: {
          mode: "enrolled",
          dailyBudget: 1,
          reviewedDryRun: "fixture",
        },
      } as const;
      const lag: BackgroundReplaySource[] = [];
      const exhausted: BackgroundReplaySource[] = [];
      const store = createBackgroundReplayStore({
        db,
        now: () => Date.UTC(2026, 9, 1),
        enrolment,
        onLag: (source) => {
          lag.push(source);
        },
        onBudgetExhausted: (source) => {
          exhausted.push(source);
        },
      });
      const selected = await store.chooseSource();
      expect(selected?.id).toBe(eu.source.id);
      expect(selected?.currentParserVersion).toBe(euVersion);
      expect(lag.find((source) => source.id === eu.source.id)).toMatchObject({
        rowsBehind: 3,
        blockedCount: 1,
      });
      expect(lag.find((source) => source.id === cz.source.id)).toMatchObject({
        rowsBehind: 1,
        blockedCount: 0,
      });
      const disabled = createBackgroundReplayStore({
        db,
        now: () => Date.UTC(2026, 9, 1),
        enrolment,
        sourceEnabled: (key) => key !== ADAPTER_KEYS.EU_ECJ,
      });
      expect((await disabled.chooseSource())?.id).toBe(cz.source.id);
      if (!selected) {
        throw new TypeError("Expected largest lag source");
      }
      sources.push(selected, { ...cz.source, currentParserVersion: czVersion });
      const reserved = await store.reserveBatch(
        selected,
        "2026-10-01",
        verdict(),
      );
      expect(reserved.type).toBe("reserved");
      if (reserved.type !== "reserved") {
        throw new TypeError("Expected largest lag reservation");
      }
      // Its charged pending work remains recoverable without another allowance.
      expect((await store.chooseSource())?.id).toBe(eu.source.id);
      await store.completeBatch(reserved.batch, {
        report: {
          id: reserved.batch.decisionId,
          caseNumber: "fixture",
          language: "cs",
          outcome: REPLAY_ROW_OUTCOME.REJECTED,
          rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
        },
        durationMs: 1,
        verdict: verdict(),
      });
      expect((await store.chooseSource())?.id).toBe(cz.source.id);
      expect(exhausted.map((source) => source.id)).toEqual([eu.source.id]);
    });

    test("charges reservations once, reuses pending work, and resets the daily allowance", async () => {
      const { source, store } = await fixture(1);
      const first = await store.reserveBatch(source, "2026-10-01", verdict());
      expect(first.type).toBe("reserved");
      if (first.type !== "reserved") {
        return;
      }
      expect(await store.pendingBatch(source, "2026-10-01")).toEqual(first);
      const retry = await store.reserveBatch(source, "2026-10-01", verdict());
      expect(retry).toEqual(first);
      await db
        .update(caseLawDecisions)
        .set({ parserVersion: 2 })
        .where(eq(caseLawDecisions.id, first.batch.decisionId));
      await store.completeBatch(first.batch, applied(first.batch));
      await store.completeBatch(first.batch, applied(first.batch));
      expect(await store.reserveBatch(source, "2026-10-01", verdict())).toEqual(
        { type: "budget-exhausted" },
      );
      const next = await store.reserveBatch(source, "2026-10-02", verdict());
      expect(next.type).toBe("reserved");
      if (next.type !== "reserved") {
        return;
      }
      expect(next.batch.decisionId).not.toBe(first.batch.decisionId);
      const receipts = await db
        .select()
        .from(caseLawReplayBatches)
        .where(eq(caseLawReplayBatches.sourceId, source.id));
      expect(receipts).toHaveLength(2);
      expect(receipts.reduce((sum, row) => sum + row.attempted, 0)).toBe(2);
      const checkpoint = (
        await db
          .select()
          .from(databaseBackfillStates)
          .where(
            eq(databaseBackfillStates.name, `case-law-replay:${source.id}:2`),
          )
      ).at(0);
      expect(checkpoint?.cursor).toBe(first.batch.decisionId);
    });

    test("pending recovery consumes the new day's allowance only once", async () => {
      const { source, store } = await fixture(1);
      const reserved = await store.reserveBatch(
        source,
        "2026-10-01",
        verdict(),
      );
      expect(reserved.type).toBe("reserved");
      if (reserved.type !== "reserved") {
        return;
      }
      expect(await store.pendingBatch(source, "2026-10-02")).toEqual(reserved);
      expect(await store.pendingBatch(source, "2026-10-02")).toEqual(reserved);
      const charges = await db
        .select()
        .from(caseLawReplayDailyRows)
        .where(eq(caseLawReplayDailyRows.sourceId, source.id));
      expect(charges.map((row) => row.budgetDay).toSorted()).toEqual([
        "2026-10-01",
        "2026-10-02",
      ]);
      await db
        .update(caseLawDecisions)
        .set({ parserVersion: 2 })
        .where(eq(caseLawDecisions.id, reserved.batch.decisionId));
      await store.completeBatch(reserved.batch, applied(reserved.batch));
      expect(await store.reserveBatch(source, "2026-10-02", verdict())).toEqual(
        { type: "budget-exhausted" },
      );
    });

    test("an applied pipeline write survives receipt failure and recovery never applies it twice", async () => {
      const { source, store } = await fixture(2);
      const reserved = await store.reserveBatch(
        source,
        "2026-10-01",
        verdict(),
      );
      expect(reserved.type).toBe("reserved");
      if (reserved.type !== "reserved") {
        return;
      }
      const registered = getAdapter(ADAPTER_KEYS.EU_ECJ);
      if (!registered) {
        throw new TypeError("Expected registered replay adapter");
      }
      const adapter = {
        ...registered,
        reparseStoredRaw: (
          stored: Parameters<
            NonNullable<typeof registered.reparseStoredRaw>
          >[0],
        ) => ({
          type: "parsed" as const,
          result: {
            caseNumber: stored.caseNumber,
            court: stored.court,
            country: "CZE",
            language: stored.language,
            metadata: stored.metadata,
            parserVersion: 2,
            rawHash: "replay-store-new-parser",
            textFields: absentDecisionTextFields(
              TEXT_ABSENCE_REASON.NOT_PUBLISHED,
            ),
            fulltext: "Text rozhodnutí po opravě parseru.",
            documentAst: EMPTY_AST,
          },
        }),
      };
      const fake = startFakeS3();
      const firstLease = await acquireCaseLawSourceIngestionLease({
        scopedDb,
        sourceId: source.id,
      });
      if (!firstLease) {
        fake.stop();
        throw new TypeError("Expected initial ingestion lease");
      }
      let activeStore = store;
      const options = {
        adapter,
        scopedDb,
        sourceId: source.id,
        scope: {
          type: "decision",
          decisionId: reserved.batch.decisionId,
        } as const,
        bound: { type: "at-most", limit: 1 } as const,
        pageSize: 1,
        readStoredRaw: async () =>
          new TextEncoder().encode("<html>stored decision</html>"),
      };
      try {
        const firstRunner = createBackgroundReplayRunner({
          rootDb: db,
          ingestionDb: scopedDb,
          getLease: () => firstLease,
          assertSlot: async () => {},
          log: () => {},
          adapterFor: () => adapter,
          readStoredRaw: options.readStoredRaw,
          store: {
            ...store,
            completeBatch: async (...args) =>
              await activeStore.completeBatch(...args),
          },
        });
        const first = await firstRunner.replay(reserved.batch, { apply: true });
        expect(first.haltReason).toBeNull();
        expect(first.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(1);
        const committed = (
          await db
            .select()
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.id, reserved.batch.decisionId))
        ).at(0);
        expect(committed?.parserVersion).toBe(2);
        expect(committed?.fulltext).toBe("Text rozhodnutí po opravě parseru.");
        const writes = fake.requests.filter(
          ({ method }) => method === "PUT",
        ).length;
        expect(writes).toBeGreaterThan(0);
        await withGatedTestClients(
          databaseUrl,
          async ({ openClient }) => {
            const admin = openClient().sql;
            let reachedCheckpoint = false;
            const killedStore = createBackgroundReplayStore({
              db,
              now: () => Date.UTC(2026, 9, 1),
              beforeCheckpoint: async (tx) => {
                const backend = (
                  await tx
                    .select({ pid: sql<number>`pg_backend_pid()` })
                    .from(caseLawReplayBatches)
                    .where(eq(caseLawReplayBatches.id, reserved.batch.id))
                    .limit(1)
                ).at(0);
                if (!backend) {
                  throw new TypeError("Missing applied completion PID");
                }
                reachedCheckpoint = true;
                await admin`SELECT pg_terminate_backend(${backend.pid}, 5000)`;
              },
            });
            activeStore = killedStore;
            const result = await Result.tryPromise(() =>
              firstRunner.completeBatch(reserved.batch, {
                report: first,
                durationMs: 1,
                verdict: verdict(),
              }),
            );
            expect(reachedCheckpoint).toBe(true);
            expect(Result.isError(result)).toBe(true);
          },
          { closeTimeout: 0 },
        );
        await firstLease.release();
        expect(await store.pendingBatch(source, "2026-10-01")).toEqual(
          reserved,
        );
        const secondLease = await acquireCaseLawSourceIngestionLease({
          scopedDb,
          sourceId: source.id,
        });
        if (!secondLease) {
          throw new TypeError("Expected recovered ingestion lease");
        }
        try {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const recoveredRunner = createBackgroundReplayRunner({
              rootDb: db,
              ingestionDb: scopedDb,
              getLease: () => secondLease,
              assertSlot: async () => {},
              log: () => {},
              store,
              adapterFor: () => adapter,
              readStoredRaw: options.readStoredRaw,
            });
            const recovered = await recoveredRunner.replay(reserved.batch, {
              apply: true,
            });
            expect(recovered.outcomes[REPLAY_ROW_OUTCOME.UNCHANGED]).toBe(1);
            expect(recovered.outcomes[REPLAY_ROW_OUTCOME.WOULD_APPLY]).toBe(0);
            await recoveredRunner.completeBatch(reserved.batch, {
              report: recovered,
              durationMs: 1,
              verdict: verdict(),
            });
          }
        } finally {
          await secondLease.release();
        }
        expect(
          fake.requests.filter(({ method }) => method === "PUT"),
        ).toHaveLength(writes);
        const recovered = (
          await db
            .select()
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.id, reserved.batch.decisionId))
        ).at(0);
        expect(recovered?.sourceObservationOrder).toBe(
          committed?.sourceObservationOrder,
        );
        expect(recovered?.updatedAt).toEqual(committed?.updatedAt);
        expect(
          await db
            .select()
            .from(caseLawReplayBatches)
            .where(eq(caseLawReplayBatches.sourceId, source.id)),
        ).toHaveLength(1);
        expect(
          await db
            .select()
            .from(caseLawReplayDailyRows)
            .where(eq(caseLawReplayDailyRows.sourceId, source.id)),
        ).toHaveLength(1);
      } finally {
        await firstLease.release();
        fake.stop();
      }
    });

    test("lost heavy-slot sessions fence parser stamps and document writes before any effect", async () => {
      const registered = getAdapter(ADAPTER_KEYS.EU_ECJ);
      if (!registered) {
        throw new TypeError("Expected registered replay adapter");
      }
      const fake = startFakeS3();
      try {
        for (const mode of ["parser-stamp", "document-write"] as const) {
          const { source, store } = await fixture(1);
          const reserved = await store.reserveBatch(
            source,
            "2026-10-01",
            verdict(),
          );
          if (reserved.type !== "reserved") {
            throw new TypeError("Expected fenced replay reservation");
          }
          let fulltext = "Text rozhodnutí před opravou parseru.";
          const adapter = {
            ...registered,
            reparseStoredRaw: (
              stored: Parameters<
                NonNullable<typeof registered.reparseStoredRaw>
              >[0],
            ) => ({
              type: "parsed" as const,
              result: {
                caseNumber: stored.caseNumber,
                court: stored.court,
                country: "CZE",
                language: stored.language,
                metadata: stored.metadata,
                parserVersion: 2,
                rawHash: "replay-slot-fence",
                textFields: absentDecisionTextFields(
                  TEXT_ABSENCE_REASON.NOT_PUBLISHED,
                ),
                fulltext,
                documentAst: EMPTY_AST,
              },
            }),
          };
          const lease = await acquireCaseLawSourceIngestionLease({
            scopedDb,
            sourceId: source.id,
          });
          if (!lease) {
            throw new TypeError("Expected fenced replay source lease");
          }
          const raw = new TextEncoder().encode("<html>stored decision</html>");
          try {
            const seeded = createBackgroundReplayRunner({
              rootDb: db,
              ingestionDb: scopedDb,
              getLease: () => lease,
              assertSlot: async () => {},
              store,
              log: () => {},
              adapterFor: () => adapter,
              readStoredRaw: async () => raw,
            });
            expect(
              (await seeded.replay(reserved.batch, { apply: true })).outcomes
                .applied,
            ).toBe(1);
            const fixedPoint = await replayCaseLawSource({
              adapter,
              scopedDb,
              sourceId: source.id,
              scope: {
                type: "decision",
                decisionId: reserved.batch.decisionId,
              },
              bound: { type: "at-most", limit: 1 },
              pageSize: 1,
              sourceLease: null,
              readStoredRaw: async () => raw,
            });
            if (fixedPoint.type !== "ran") {
              throw new TypeError("Expected seeded replay fixed point");
            }
            expect(fixedPoint.report.outcomes.unchanged).toBe(1);
            await db
              .update(caseLawDecisions)
              .set({ parserVersion: 1 })
              .where(eq(caseLawDecisions.id, reserved.batch.decisionId));
            if (mode === "document-write") {
              fulltext = "Text rozhodnutí po opravě parseru.";
            }
            const before = (
              await db
                .select()
                .from(caseLawDecisions)
                .where(eq(caseLawDecisions.id, reserved.batch.decisionId))
            ).at(0);
            if (before === undefined) {
              throw new TypeError("Expected seeded decision before fencing");
            }
            const writesBefore = fake.requests.filter(
              ({ method }) => method === "PUT",
            ).length;
            await withGatedTestClients(
              databaseUrl,
              async ({ openClient }) => {
                const first = await openClient().sql.reserve();
                const rival = await openClient().sql.reserve();
                const admin = openClient().sql;
                const makeSlot = (session: typeof first) =>
                  createHeavyWorkSlot({
                    kind: "backfill_batch",
                    session: {
                      query: async (statement, parameters) =>
                        await session.unsafe<{ acquired: boolean }[]>(
                          statement,
                          [...parameters],
                        ),
                    },
                  });
                const firstSlot = makeSlot(first);
                const rivalSlot = makeSlot(rival);
                const expectAcquisition = async (
                  slot: typeof firstSlot,
                  expected: boolean,
                ) => {
                  const acquired = await slot.tryAcquire();
                  if (acquired.isErr()) {
                    throw acquired.error;
                  }
                  expect(acquired.value).toBe(expected);
                };
                const pid = (
                  await first.unsafe<{ pid: number }[]>(
                    "SELECT pg_backend_pid() AS pid",
                  )
                ).at(0)?.pid;
                if (pid === undefined) {
                  throw new TypeError("Missing heavy-slot backend identity");
                }
                let reads = 0;
                let fenceChecks = 0;
                let killed = false;
                try {
                  await expectAcquisition(firstSlot, true);
                  await expectAcquisition(rivalSlot, false);
                  const runner = createBackgroundReplayRunner({
                    rootDb: db,
                    ingestionDb: scopedDb,
                    getLease: () => lease,
                    store,
                    log: () => {},
                    adapterFor: () => adapter,
                    readStoredRaw: async () => {
                      reads += 1;
                      if (reads === 2) {
                        const terminated = await admin<
                          { terminated: boolean }[]
                        >`SELECT pg_terminate_backend(${pid}, 5000) AS terminated`;
                        expect(terminated.at(0)?.terminated).toBe(true);
                        killed = true;
                        await expectAcquisition(rivalSlot, true);
                      }
                      return raw;
                    },
                    assertSlot: async () => {
                      fenceChecks += 1;
                      const current = (
                        await first.unsafe<{ pid: number }[]>(
                          "SELECT pg_backend_pid() AS pid",
                        )
                      ).at(0)?.pid;
                      if (current !== pid) {
                        throw new TypeError("Heavy-work session was replaced");
                      }
                    },
                  });
                  const replayed = await runner.replay(reserved.batch, {
                    apply: true,
                  });
                  expect(reads).toBe(2);
                  expect(killed).toBe(true);
                  expect(fenceChecks).toBeGreaterThan(0);
                  expect(replayed.outcomes.applied).toBe(0);
                  expect(replayed.haltReason).not.toBeNull();
                  expect(
                    await db
                      .select()
                      .from(caseLawDecisions)
                      .where(
                        eq(caseLawDecisions.id, reserved.batch.decisionId),
                      ),
                  ).toEqual([before]);
                  expect(
                    fake.requests.filter(({ method }) => method === "PUT"),
                  ).toHaveLength(writesBefore);
                  expect(
                    await store.pendingBatch(source, "2026-10-01"),
                  ).toEqual(reserved);
                  const checkpoint = (
                    await db
                      .select()
                      .from(databaseBackfillStates)
                      .where(
                        eq(
                          databaseBackfillStates.name,
                          `case-law-replay:${source.id}:2`,
                        ),
                      )
                  ).at(0);
                  expect(checkpoint?.cursor).toBeNull();
                } finally {
                  await rivalSlot.close();
                  if (!killed) {
                    await firstSlot.close();
                  }
                  first.release();
                  rival.release();
                }
              },
              { closeTimeout: 0 },
            );
          } finally {
            await lease.release();
          }
        }
      } finally {
        fake.stop();
      }
    });

    test("runner apply mode never writes any classified rejection", async () => {
      const registered = getAdapter(ADAPTER_KEYS.EU_ECJ);
      if (!registered) {
        throw new TypeError("Expected registered replay adapter");
      }
      const fake = startFakeS3();
      try {
        for (const rejection of Object.values(STORED_RAW_REPARSE_REJECTION)) {
          const { source, store } = await fixture(1);
          const reserved = await store.reserveBatch(
            source,
            "2026-10-01",
            verdict(),
          );
          expect(reserved.type).toBe("reserved");
          if (reserved.type !== "reserved") {
            throw new TypeError("Expected rejected-row reservation");
          }
          const before = (
            await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, reserved.batch.decisionId))
          ).at(0);
          const runner = createBackgroundReplayRunner({
            rootDb: db,
            ingestionDb: scopedDb,
            getLease: () => null,
            assertSlot: async () => {
              throw new TypeError("Rejected preview must not enter writer");
            },
            store,
            log: () => {},
            readStoredRaw: async () =>
              new TextEncoder().encode("rejected fixture"),
            adapterFor: () => ({
              ...registered,
              reparseStoredRaw: () => ({
                type: "rejected",
                rejection,
                detail: "synthetic rejected payload",
              }),
            }),
          });
          const report = await runner.replay(reserved.batch, { apply: true });
          expect(report.outcomes[REPLAY_ROW_OUTCOME.REJECTED]).toBe(1);
          expect(report.outcomes[REPLAY_ROW_OUTCOME.APPLIED]).toBe(0);
          await runner.completeBatch(reserved.batch, {
            report,
            durationMs: 1,
            verdict: verdict(),
          });
          const after = (
            await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, reserved.batch.decisionId))
          ).at(0);
          expect(after).toEqual(before);
          expect(fake.requests).toHaveLength(0);
        }
      } finally {
        fake.stop();
      }
    });

    test("a pending older generation is superseded before reserving the newer parser", async () => {
      const { source, store } = await fixture(1);
      const old = await store.reserveBatch(source, "2026-10-01", verdict());
      expect(old.type).toBe("reserved");
      if (old.type !== "reserved") {
        return;
      }
      const nextSource = { ...source, currentParserVersion: 3 };
      expect(await store.pendingBatch(nextSource, "2026-10-02")).toEqual({
        type: "empty",
      });
      const superseded = (
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, old.batch.id))
      ).at(0);
      expect(superseded?.status).toBe("superseded");
      const next = await store.reserveBatch(
        nextSource,
        "2026-10-02",
        verdict(),
      );
      expect(next.type).toBe("reserved");
      if (next.type !== "reserved") {
        return;
      }
      expect(next.batch.targetParserVersion).toBe(3);
      expect(next.batch.decisionId).toBe(old.batch.decisionId);
      expect(next.batch.id).not.toBe(old.batch.id);
      sources.push(nextSource);
    });

    test("backend death rolls receipt and blocked outcome back together, then resumes twice", async () => {
      const { source, store } = await fixture(2);
      const reserved = await store.reserveBatch(
        source,
        "2026-10-01",
        verdict(),
      );
      expect(reserved.type).toBe("reserved");
      if (reserved.type !== "reserved") {
        return;
      }
      const completion = {
        report: {
          id: reserved.batch.decisionId,
          caseNumber: "fixture",
          language: "cs",
          outcome: REPLAY_ROW_OUTCOME.REJECTED,
          rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
        },
        durationMs: 1,
        verdict: verdict(),
      };
      await withGatedTestClients(
        databaseUrl,
        async ({ openClient }) => {
          const admin = openClient().sql;
          let reachedCheckpoint = false;
          const killedStore = createBackgroundReplayStore({
            db,
            now: () => Date.UTC(2026, 9, 1),
            beforeCheckpoint: async (tx) => {
              const backend = (
                await tx
                  .select({ pid: sql<number>`pg_backend_pid()` })
                  .from(caseLawReplayBatches)
                  .where(eq(caseLawReplayBatches.id, reserved.batch.id))
                  .limit(1)
              ).at(0);
              if (backend === undefined) {
                throw new TypeError("Missing completion backend PID");
              }
              reachedCheckpoint = true;
              await admin`SELECT pg_terminate_backend(${backend.pid}, 5000)`;
            },
          });
          const result = await Result.tryPromise(() =>
            killedStore.completeBatch(reserved.batch, completion),
          );
          expect(reachedCheckpoint).toBe(true);
          expect(Result.isError(result)).toBe(true);
        },
        { closeTimeout: 0 },
      );
      const receipt = (
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, reserved.batch.id))
      ).at(0);
      expect(receipt?.status).toBe("reserved");
      expect(
        await db
          .select()
          .from(caseLawReplayBlocked)
          .where(eq(caseLawReplayBlocked.sourceId, source.id)),
      ).toHaveLength(0);
      const checkpoint = (
        await db
          .select()
          .from(databaseBackfillStates)
          .where(
            eq(databaseBackfillStates.name, `case-law-replay:${source.id}:2`),
          )
      ).at(0);
      expect(checkpoint?.cursor).toBeNull();
      expect(await store.pendingBatch(source, "2026-10-01")).toEqual(reserved);
      await store.completeBatch(reserved.batch, completion);
      await store.completeBatch(reserved.batch, completion);
      expect(
        await db
          .select()
          .from(caseLawReplayBlocked)
          .where(eq(caseLawReplayBlocked.sourceId, source.id)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.sourceId, source.id)),
      ).toHaveLength(1);
      const settled = (
        await db
          .select()
          .from(databaseBackfillStates)
          .where(
            eq(databaseBackfillStates.name, `case-law-replay:${source.id}:2`),
          )
      ).at(0);
      expect(settled?.cursor).toBe(reserved.batch.decisionId);
    });

    test("concurrent reservation calls return the same single charged receipt", async () => {
      const { source, store } = await fixture(3);
      const results = await Promise.all([
        store.reserveBatch(source, "2026-10-01", verdict()),
        store.reserveBatch(source, "2026-10-01", verdict()),
      ]);
      expect(results.at(0)?.type).toBe("reserved");
      expect(results.at(1)).toEqual(results.at(0));
      expect(
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.sourceId, source.id)),
      ).toHaveLength(1);
    });

    test("rejected completion is idempotent and removes only the current blocked generation from selection", async () => {
      const { source, store } = await fixture(3);
      const reserved = await store.reserveBatch(
        source,
        "2026-10-01",
        verdict(),
      );
      expect(reserved.type).toBe("reserved");
      if (reserved.type !== "reserved") {
        return;
      }
      const completion = {
        report: {
          id: reserved.batch.decisionId,
          caseNumber: "fixture",
          language: "cs",
          outcome: REPLAY_ROW_OUTCOME.REJECTED,
          rejection: STORED_RAW_REPARSE_REJECTION.IDENTITY_MISMATCH,
          detail: "fixture identity changed",
        },
        durationMs: 1,
        verdict: verdict(),
      };
      await store.completeBatch(reserved.batch, completion);
      await store.completeBatch(reserved.batch, completion);
      expect(
        await db
          .select()
          .from(caseLawReplayBlocked)
          .where(eq(caseLawReplayBlocked.sourceId, source.id)),
      ).toHaveLength(1);
      const row = (
        await db
          .select()
          .from(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.id, reserved.batch.id))
      ).at(0);
      expect(row?.status).toBe("completed");
      expect(row?.blocked).toBe(1);
      expect(row?.applied).toBe(0);
      const scope = {
        type: "decision",
        decisionId: reserved.batch.decisionId,
      } as const;
      expect(
        await selectScopeEnd({
          scopedDb,
          sourceId: source.id,
          scope,
          selection: { type: "background", currentParserVersion: 2 },
        }),
      ).toBeNull();
      expect(
        await selectScopeEnd({
          scopedDb,
          sourceId: source.id,
          scope,
          selection: { type: "background", currentParserVersion: 3 },
        }),
      ).toBe(reserved.batch.decisionId);
      expect(await store.pendingBatch(source, "2026-10-01")).toEqual({
        type: "empty",
      });
      const checkpoint = (
        await db
          .select()
          .from(databaseBackfillStates)
          .where(
            eq(databaseBackfillStates.name, `case-law-replay:${source.id}:2`),
          )
      ).at(0);
      expect(checkpoint?.cursor).toBe(reserved.batch.decisionId);
    });
  });
}
