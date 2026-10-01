import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";
import { createHeavyWorkSlot } from "@stll/db-load-gate/slot";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawReplayBatches,
  caseLawReplayDailyRows,
  caseLawSources,
  databaseBackfillStates,
} from "@/api/db/schema";
import {
  runBackgroundReplayTick,
  type BackgroundReplayBatch,
  type BackgroundReplaySource,
  type BackgroundReplayTickReport,
} from "@/api/handlers/case-law/ingestion/background-replay";
import { createBackgroundReplayStore } from "@/api/handlers/case-law/ingestion/background-replay-store";
import {
  REPLAY_ROW_OUTCOME,
  type ReplayRunReport,
} from "@/api/handlers/case-law/ingestion/replay";
import { createSafeId } from "@/api/lib/branded-types";
import {
  acquireCaseLawSourceIngestionLease,
  type CaseLawSourceIngestionLease,
} from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import {
  openGatedTestDatabase,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const healthy = () => ({ kind: "normal", signals: [] }) satisfies Verdict;

const applied = (batch: BackgroundReplayBatch): ReplayRunReport => ({
  visited: 1,
  outcomes: {
    applied: 1,
    unchanged: 0,
    "would-apply": 0,
    rejected: 0,
    "missing-payload": 0,
    retryable: 0,
    withdrawn: 0,
    "withdraw-incomplete": 0,
    "would-withdraw": 0,
  },
  rejections: {
    "incomplete-metadata": 0,
    "identity-mismatch": 0,
    "raw-fidelity-lost": 0,
    "unsupported-content": 0,
    "no-document": 0,
    supplement: 0,
  },
  problems: [],
  omittedProblems: 0,
  resumeAfter: batch.decisionId,
  haltReason: null,
});

if (!databaseUrl || !enabled) {
  describe.skip("background replay ownership and durable batch boundaries", () => {
    test("requires explicitly enabled Postgres", () =>
      expect(enabled && Boolean(databaseUrl)).toBe(false));
  });
} else {
  describe("background replay ownership and durable batch boundaries", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(callback);
    const sources: BackgroundReplaySource[] = [];
    cleanUp(async () => {
      for (const source of sources) {
        await db
          .delete(caseLawReplayDailyRows)
          .where(eq(caseLawReplayDailyRows.sourceId, source.id));
        await db
          .delete(caseLawReplayBatches)
          .where(eq(caseLawReplayBatches.sourceId, source.id));
        await db
          .delete(databaseBackfillStates)
          .where(
            eq(databaseBackfillStates.name, `case-law-replay:${source.id}:2`),
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
        adapterKey: `engine-${source.id}`,
        name: "replay engine fixture",
      });
      const ids = Array.from({ length: 3 }, () =>
        createSafeId<"caseLawDecision">(),
      ).toSorted();
      await db.insert(caseLawDecisions).values(
        ids.map((id, index) => ({
          id,
          sourceId: source.id,
          caseNumber: `engine-${index}`,
          court: "fixture court",
          country: "CZE",
          language: "cs",
          parserVersion: 1,
          sourceRawS3Key: `fixture/${id}`,
        })),
      );
      let clock = Date.UTC(2026, 9, 1);
      const metrics: BackgroundReplayTickReport[] = [];
      const store = createBackgroundReplayStore({ db, now: () => clock });
      const checkpoint = async () =>
        (
          await db
            .select()
            .from(databaseBackfillStates)
            .where(
              eq(databaseBackfillStates.name, `case-law-replay:${source.id}:2`),
            )
        ).at(0);
      return {
        source,
        ids,
        store,
        metrics,
        now: () => clock,
        nextDay: () => {
          clock += 86_400_000;
        },
        checkpoint,
      };
    };
    type Fixture = Awaited<ReturnType<typeof fixture>>;
    type TickOptions = {
      fixture: Fixture;
      slot: ReturnType<typeof createHeavyWorkSlot>;
      beforeReplay?: () => Promise<void>;
      gate?: () => Promise<Verdict>;
      maxRows?: number;
    };
    const tick = async ({
      fixture: state,
      slot,
      beforeReplay,
      gate = async () => healthy(),
      maxRows = 10,
    }: TickOptions) => {
      let lease: CaseLawSourceIngestionLease | null = null;
      return await runBackgroundReplayTick({
        maxRows,
        maxDurationMs: 60_000,
        errorRateCeiling: 0.1,
        healthConfig: { ...defaultConfig, minSleepMs: 0 },
        dependencies: {
          ...state.store,
          chooseSource: async () => state.source,
          reserveBatch: async (source, day) =>
            await state.store.reserveBatch(source, day, healthy()),
          killRequested: async () => false,
          acquireLease: async (source) => {
            lease = await acquireCaseLawSourceIngestionLease({
              scopedDb,
              sourceId: source.id,
            });
            if (lease === null) {
              return null;
            }
            return lease.release;
          },
          acquireHeavySlot: async () => {
            const result = await slot.tryAcquire();
            if (result.isErr()) {
              throw result.error;
            }
            return result.value ? slot.release : null;
          },
          gate,
          replay: async (batch) => {
            await beforeReplay?.();
            if (lease === null) {
              return panic("Fixture replay requires an ingestion lease");
            }
            await lease.beforeDatabaseMark();
            await db
              .update(caseLawDecisions)
              .set({ parserVersion: 2 })
              .where(eq(caseLawDecisions.id, batch.decisionId));
            return applied(batch);
          },
          completeBatch: async (batch, completion) =>
            await state.store.completeBatch(batch, {
              ...completion,
              report: {
                id: batch.decisionId,
                caseNumber: "fixture",
                language: "cs",
                outcome: REPLAY_ROW_OUTCOME.APPLIED,
              },
            }),
          metric: (report) => {
            state.metrics.push(report);
          },
          now: state.now,
          sleep: async () => {},
        },
      });
    };
    type SlotTestOptions = {
      run: (
        slots: readonly [
          ReturnType<typeof createHeavyWorkSlot>,
          ReturnType<typeof createHeavyWorkSlot>,
        ],
      ) => Promise<void>;
    };
    const withSlots = async ({ run }: SlotTestOptions) =>
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const first = await openClient().sql.reserve();
        const second = await openClient().sql.reserve();
        const makeSlot = (session: typeof first) =>
          createHeavyWorkSlot({
            kind: "backfill_batch",
            session: {
              query: async (statement, parameters) =>
                await session.unsafe<{ acquired: boolean }[]>(statement, [
                  ...parameters,
                ]),
            },
          });
        const slots = [makeSlot(first), makeSlot(second)] as const;
        try {
          await run(slots);
        } finally {
          await slots[0].close();
          await slots[1].close();
          first.release();
          second.release();
        }
      });

    test("two ticks use real source leases and session slots to admit one writer", async () => {
      const state = await fixture(3);
      await withSlots({
        run: async ([firstSlot, secondSlot]) => {
          const entered = Promise.withResolvers<undefined>();
          const resume = Promise.withResolvers<undefined>();
          const first = tick({
            fixture: state,
            slot: firstSlot,
            maxRows: 1,
            beforeReplay: async () => {
              entered.resolve(undefined);
              await resume.promise;
            },
          });
          await entered.promise;
          try {
            expect(
              (await tick({ fixture: state, slot: secondSlot, maxRows: 1 }))
                .status,
            ).toBe("lease-unavailable");
            const contender = await secondSlot.tryAcquire();
            expect(contender.isOk() && contender.value).toBe(false);
            expect(await state.checkpoint()).toMatchObject({ cursor: null });
          } finally {
            resume.resolve(undefined);
            await first;
          }
          expect((await first).applied).toBe(1);
          const receipts = await db
            .select()
            .from(caseLawReplayBatches)
            .where(eq(caseLawReplayBatches.sourceId, state.source.id));
          expect(receipts).toHaveLength(1);
          expect(receipts.at(0)?.status).toBe("completed");
          expect((await state.checkpoint())?.cursor).toBe(state.ids.at(0));
          expect(state.metrics.map((report) => report.status)).toEqual([
            "lease-unavailable",
            "row-limit",
          ]);
        },
      });
    });

    test("a gate trip preserves the committed cursor and creates no next reservation", async () => {
      const state = await fixture(3);
      let batches = 0;
      await withSlots({
        run: async ([slot]) => {
          const report = await tick({
            fixture: state,
            slot,
            beforeReplay: async () => {
              batches += 1;
            },
            gate: async () => ({
              kind: batches === 0 ? "normal" : "unknown",
              signals: [],
            }),
          });
          expect(report.status).toBe("held");
          expect(report.applied).toBe(1);
          expect((await state.checkpoint())?.cursor).toBe(state.ids.at(0));
          expect(
            await db
              .select()
              .from(caseLawReplayBatches)
              .where(eq(caseLawReplayBatches.sourceId, state.source.id)),
          ).toHaveLength(1);
        },
      });
    });

    test("daily exhaustion stops writes and a UTC rollover resumes after the durable cursor", async () => {
      const state = await fixture(1);
      await withSlots({
        run: async ([slot]) => {
          expect((await tick({ fixture: state, slot })).status).toBe(
            "budget-exhausted",
          );
          expect((await tick({ fixture: state, slot })).applied).toBe(0);
          state.nextDay();
          expect((await tick({ fixture: state, slot })).applied).toBe(1);
          expect((await state.checkpoint())?.cursor).toBe(state.ids.at(1));
          const charges = await db
            .select()
            .from(caseLawReplayDailyRows)
            .where(eq(caseLawReplayDailyRows.sourceId, state.source.id));
          expect(charges.map((row) => row.budgetDay).toSorted()).toEqual([
            "2026-10-01",
            "2026-10-02",
          ]);
        },
      });
    });
  });
}
