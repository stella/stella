import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";

import { defaultConfig, type Verdict } from "@stll/db-load-gate/health";
import {
  createHeavyWorkSlot,
  type HeavyWorkKind,
} from "@stll/db-load-gate/slot";

import {
  CORPUS_SCHEMA_LANE_LOCK_SQL,
  CORPUS_SCHEMA_LANE_UNLOCK_SQL,
  runUnderCorpusSchemaLane,
} from "@/api/db/corpus-schema-lane";
import { withLongRunningConnection } from "@/api/db/long-running-connection";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawReplayBatches,
  caseLawReplayAuditEvents,
  caseLawReplayBlocked,
  caseLawReplaySourceProgress,
  caseLawReplayDailyRows,
  caseLawSources,
  databaseBackfillStates,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { envDbLoadGate } from "@/api/env-db-load-gate";
import {
  EMPTY_AST,
  type SourceAdapter,
  type StoredRawReader,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  runBackgroundReplayTick,
  type BackgroundReplayBatch,
  type BackgroundReplaySource,
  type BackgroundReplayTickReport,
} from "@/api/handlers/case-law/ingestion/background-replay";
import { createBackgroundReplayRunner } from "@/api/handlers/case-law/ingestion/background-replay-runner";
import { createBackgroundReplayStore } from "@/api/handlers/case-law/ingestion/background-replay-store";
import {
  REPLAY_ROW_OUTCOME,
  type ReplayRunReport,
} from "@/api/handlers/case-law/ingestion/replay";
import {
  BACKGROUND_REPLAY_LIMITS,
  REPLAY_ENROLMENT,
} from "@/api/handlers/case-law/ingestion/replay-enrolment";
import { createSafeId } from "@/api/lib/branded-types";
import {
  absentDecisionTextFields,
  TEXT_ABSENCE_REASON,
} from "@/api/lib/case-law/decision-text";
import {
  acquireCaseLawSourceIngestionLease,
  type CaseLawSourceIngestionLease,
} from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/lib/legal-search/ingestion-constants";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { isUsableStaticCredential } from "@/api/lib/s3/credentials";
import {
  openGatedTestDatabase,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import { runReplayTickFixture } from "@/api/tests/helpers/replay-tick";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const healthy = () => ({ kind: "normal", signals: [] }) satisfies Verdict;

const startReplayFixtureStorage = () => {
  expect(isUsableStaticCredential(envBase.S3_ACCESS_KEY_ID)).toBe(true);
  expect(isUsableStaticCredential(envBase.S3_SECRET_ACCESS_KEY)).toBe(true);
  const endpoint = envBase.S3_ENDPOINT;
  const localCredentials =
    envBase.S3_CREDENTIALS_PROVIDER === "env" ||
    (envBase.S3_CREDENTIALS_PROVIDER === "auto" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(new URL(endpoint).hostname));
  // Strict refresh must stay on static fixture credentials, never ECS/IMDS.
  expect(localCredentials).toBe(true);
  return startFakeS3();
};

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

/** How long the deadline test waits for a server-side state to appear. */
const BLOCKED_QUERY_DEADLINE_MS = 10_000;

/** Polls `probe` until it holds or the deadline passes; true when it held. */
const waitForState = async (probe: () => Promise<boolean>) => {
  const deadline = Date.now() + BLOCKED_QUERY_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (await probe()) {
      return true;
    }
    await Bun.sleep(20);
  }
  return false;
};

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
          .delete(caseLawReplayAuditEvents)
          .where(eq(caseLawReplayAuditEvents.sourceId, source.id));
        await db
          .delete(caseLawReplayBlocked)
          .where(eq(caseLawReplayBlocked.sourceId, source.id));
        await db
          .delete(caseLawReplaySourceProgress)
          .where(eq(caseLawReplaySourceProgress.sourceId, source.id));
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
    const fixture = async (
      dailyBudget: number,
      mode: BackgroundReplaySource["mode"] = "enrolled",
    ) => {
      const source = {
        id: createSafeId<"caseLawSource">(),
        adapterKey: ADAPTER_KEYS.EU_ECJ,
        currentParserVersion: 2,
        dailyBudget,
        mode,
        rowsBehind: 3,
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
        advanceTime: (milliseconds: number) => {
          clock += milliseconds;
        },
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
      signal?: AbortSignal;
      canonical?: {
        adapter: SourceAdapter;
        readStoredRaw?: StoredRawReader | "s3";
        onPreview?: (decisionId: string) => void;
      };
    };
    const tick = async ({
      fixture: state,
      slot,
      beforeReplay,
      gate = async () => healthy(),
      maxRows = 10,
      canonical,
      signal,
    }: TickOptions) => {
      let lease: CaseLawSourceIngestionLease | null = null;
      const runner =
        canonical === undefined
          ? {}
          : createBackgroundReplayRunner({
              rootDb: db,
              ingestionDb: scopedDb,
              getLease: () => lease,
              assertSlot: async () => {},
              store: state.store,
              adapterFor: () => canonical.adapter,
              ...(signal === undefined ? {} : { signal }),
              ...(canonical.readStoredRaw === "s3"
                ? {}
                : {
                    readStoredRaw:
                      canonical.readStoredRaw ??
                      (async () =>
                        new TextEncoder().encode(
                          "<html>stored fixture judgment</html>",
                        )),
                  }),
              log: (record) => {
                if (
                  typeof record === "object" &&
                  record !== null &&
                  "decisionId" in record &&
                  typeof record.decisionId === "string"
                ) {
                  canonical.onPreview?.(record.decisionId);
                }
              },
            });
      return await runBackgroundReplayTick({
        maxRows,
        ...(signal === undefined ? {} : { signal }),
        maxDurationMs: 60_000,
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
              panic("Fixture replay requires an ingestion lease");
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
          ...runner,
        },
      });
    };
    type SlotTestOptions = {
      contenderKind?: HeavyWorkKind;
      run: (
        slots: readonly [
          ReturnType<typeof createHeavyWorkSlot>,
          ReturnType<typeof createHeavyWorkSlot>,
        ],
      ) => Promise<void>;
    };
    const withSlots = async ({
      run,
      contenderKind = "backfill_batch",
    }: SlotTestOptions) =>
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const first = await openClient().sql.reserve();
        const second = await openClient().sql.reserve();
        const makeSlot = (session: typeof first, kind: HeavyWorkKind) =>
          createHeavyWorkSlot({
            kind,
            session: {
              query: async (statement, parameters) =>
                await session.unsafe<{ acquired: boolean }[]>(statement, [
                  ...parameters,
                ]),
            },
          });
        const slots = [
          makeSlot(first, "backfill_batch"),
          makeSlot(second, contenderKind),
        ] as const;
        try {
          await run(slots);
        } finally {
          await slots[0].close();
          await slots[1].close();
          first.release();
          second.release();
        }
      });

    const canonicalReplay = (listingOnly = false, parserVersion = 2) => {
      const adapter = {
        key: ADAPTER_KEYS.EU_ECJ,
        sourceFields: {
          status: "declared",
          fields: {},
          listSourceFields: () => [],
        },
        sourceSurfaces: { surfaces: {} },
        documentStage: "inline",
        observeDocumentStage: async ({ fetchPage }) => await fetchPage(),
        name: "background replay canonical fixture",
        country: "CZE",
        language: "cs",
        minRequestIntervalMs: 0,
        fetchPage: async () => panic("Fixture replay contacted publisher"),
        getTotalCount: async () => panic("Fixture replay contacted publisher"),
        reconciliation: {
          firstSlice: "1970-01-01",
          sliceOf: () => "1970-01-01",
          nextSlice: () => null,
          previousSlice: () => null,
          tipWindowDays: 1,
          revisionOf: (payload) => payload,
          listSlicePage: async () => panic("Fixture replay listed publisher"),
          buildDecision: async () =>
            panic("Fixture replay built publisher data"),
        },
        reparseStoredRaw: (stored) => ({
          type: "parsed",
          result: plainTextIngestionResult({
            caseNumber: stored.caseNumber,
            court: stored.court,
            country: "CZE",
            language: stored.language,
            parserVersion,
            isListingOnly: listingOnly,
            textFields: absentDecisionTextFields(
              TEXT_ABSENCE_REASON.NOT_PUBLISHED,
            ),
            fulltext: "Fixture judgment rederived from stored bytes.",
            documentAst: EMPTY_AST,
            rawHash: "fixture-parser-hash",
            metadata: {},
          }),
        }),
      } satisfies SourceAdapter;
      return { adapter };
    };

    test("canonical watermark-only work stays retryable without a terminal row receipt", async () => {
      const state = await fixture(10);
      const fake = startReplayFixtureStorage();
      try {
        await withSlots({
          run: async ([slot]) => {
            expect(
              await tick({
                fixture: state,
                slot,
                canonical: canonicalReplay(true),
                maxRows: 1,
              }),
            ).toMatchObject({
              status: "failed",
              attempted: 1,
              applied: 0,
              blocked: 0,
              errors: 1,
            });
            const receipts = await db
              .select()
              .from(caseLawReplayBatches)
              .where(eq(caseLawReplayBatches.sourceId, state.source.id));
            expect(receipts).toHaveLength(1);
            expect(receipts.at(0)).toMatchObject({
              status: "reserved",
              applied: 0,
              blocked: 0,
            });
            // The failed row stays queued as a reservation, so the sweep
            // cursor moves past it instead of retrying it before later work.
            expect((await state.checkpoint())?.cursor).toBe(
              receipts.at(0)?.firstDecisionId,
            );
            expect(
              await db
                .select()
                .from(caseLawReplayBlocked)
                .where(eq(caseLawReplayBlocked.sourceId, state.source.id)),
            ).toHaveLength(0);
            const decisions = await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.sourceId, state.source.id));
            expect(
              decisions.every(({ parserVersion }) => parserVersion === 1),
            ).toBe(true);
            expect(
              fake.requests.filter(({ method }) => method === "PUT"),
            ).toHaveLength(0);
          },
        });
      } finally {
        fake.stop();
      }
    });

    test("canonical winner-settled and winner-redacted rows cannot receive a completed receipt without their parser stamp", async () => {
      for (const winner of ["settled", "redacted"] as const) {
        const state = await fixture(3);
        const id = state.ids.at(0);
        if (id === undefined) {
          panic("Expected first fixture decision");
        }
        const fake = startReplayFixtureStorage();
        try {
          await withSlots({
            run: async ([slot]) => {
              const held = fake.holdNext({
                method: "PUT",
                keyIncludes: "case-law/raw/",
              });
              const running = tick({
                fixture: state,
                slot,
                maxRows: 1,
                canonical: canonicalReplay(),
                signal: AbortSignal.timeout(10_000),
              });
              try {
                const reached = await Promise.race([
                  held.reached.then(() => "held" as const),
                  running.then(() => "finished" as const),
                ]);
                expect(reached).toBe("held");
                await db
                  .update(caseLawDecisions)
                  .set({
                    sourceObservationOrder: 10_000n,
                    ...(winner === "redacted"
                      ? { redactedAt: new Date("2026-10-01T00:00:00Z") }
                      : {}),
                  })
                  .where(eq(caseLawDecisions.id, id));
              } finally {
                held.release();
                await running;
              }
              expect(await running).toMatchObject({
                status: winner === "redacted" ? "row-limit" : "failed",
                attempted: 1,
                errors: winner === "redacted" ? 0 : 1,
                applied: 0,
                blocked: winner === "redacted" ? 1 : 0,
              });
              const receipts = await db
                .select()
                .from(caseLawReplayBatches)
                .where(eq(caseLawReplayBatches.sourceId, state.source.id));
              expect(receipts.at(0)).toMatchObject({
                status: winner === "redacted" ? "blocked" : "reserved",
                applied: 0,
                blocked: winner === "redacted" ? 1 : 0,
              });
              expect(
                (
                  await db
                    .select()
                    .from(caseLawReplayBlocked)
                    .where(eq(caseLawReplayBlocked.sourceId, state.source.id))
                ).at(0)?.reason,
              ).toBeUndefined();
              expect(
                (
                  await db
                    .select()
                    .from(caseLawDecisions)
                    .where(eq(caseLawDecisions.id, id))
                ).at(0)?.parserVersion,
              ).toBe(1);
            },
          });
        } finally {
          fake.stop();
        }
      }
    });

    test("crash-recovered database stamps are recorded as applied without reading raw storage", async () => {
      const state = await fixture(3);
      const batch = await state.store.reserveBatch(
        state.source,
        "2026-10-01",
        healthy(),
      );
      if (batch.type !== "reserved") {
        panic("Expected reserved replay receipt");
      }
      await db
        .update(caseLawDecisions)
        .set({ parserVersion: 2 })
        .where(eq(caseLawDecisions.id, batch.batch.decisionId));
      await withSlots({
        run: async ([slot]) => {
          const canonical = {
            ...canonicalReplay(),
            readStoredRaw: async () =>
              panic("Crash recovery must not read raw storage"),
          };
          expect(
            await tick({ fixture: state, slot, maxRows: 1, canonical }),
          ).toMatchObject({ applied: 1, blocked: 0 });
          expect(
            (
              await db
                .select()
                .from(caseLawReplayBatches)
                .where(eq(caseLawReplayBatches.id, batch.batch.id))
            ).at(0),
          ).toMatchObject({ status: "completed", applied: 1 });
        },
      });
    });

    test("canonical dry-run persists budgeted preview receipts while leaving decisions untouched", async () => {
      const state = await fixture(3, "dry-run");
      const before = await db
        .select()
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, state.source.id));
      const fake = startReplayFixtureStorage();
      try {
        await withSlots({
          run: async ([slot]) => {
            const visited: string[] = [];
            const canonical = {
              ...canonicalReplay(),
              onPreview: (id: string) => {
                visited.push(id);
              },
            };
            await tick({ fixture: state, slot, maxRows: 1, canonical });
            await tick({ fixture: state, slot, maxRows: 1, canonical });
            expect(visited).toEqual(state.ids.slice(0, 2));
            expect(
              await db
                .select()
                .from(caseLawDecisions)
                .where(eq(caseLawDecisions.sourceId, state.source.id)),
            ).toEqual(before);
            const receipts = await db
              .select()
              .from(caseLawReplayBatches)
              .where(eq(caseLawReplayBatches.sourceId, state.source.id));
            expect(receipts).toHaveLength(2);
            expect(
              receipts.every(
                (row) =>
                  row.id.endsWith(":dry-run") &&
                  row.status === "completed" &&
                  row.failed === 0 &&
                  row.applied === 0,
              ),
            ).toBe(true);
            expect(
              await db
                .select()
                .from(caseLawReplayDailyRows)
                .where(eq(caseLawReplayDailyRows.sourceId, state.source.id)),
            ).toHaveLength(2);
            expect(fake.requests).toHaveLength(0);
          },
        });
      } finally {
        fake.stop();
      }
    });

    test("a failed dry-run tick leaves its cursor before the row and retries after durable backoff", async () => {
      const state = await fixture(3, "dry-run");
      const before = await db
        .select()
        .from(caseLawDecisions)
        .where(eq(caseLawDecisions.sourceId, state.source.id));
      await withSlots({
        run: async ([slot]) => {
          const canonical = canonicalReplay();
          let fail = true;
          const inspected: string[] = [];
          const adapter = {
            ...canonical.adapter,
            reparseStoredRaw: (stored) => {
              inspected.push(stored.caseNumber);
              if (fail) {
                throw new TypeError("fixture adapter failure");
              }
              return canonical.adapter.reparseStoredRaw(stored);
            },
          } satisfies SourceAdapter;
          expect(
            (await tick({ fixture: state, slot, canonical: { adapter } }))
              .status,
          ).toBe("retryable");
          expect(inspected).toEqual(["engine-0"]);
          const cursor = async () =>
            (
              await db
                .select()
                .from(databaseBackfillStates)
                .where(
                  eq(
                    databaseBackfillStates.name,
                    `case-law-replay:${state.source.id}:2:dry-run`,
                  ),
                )
            ).at(0)?.cursor;
          expect(await cursor()).toBeUndefined();
          const failed = (
            await db
              .select()
              .from(caseLawReplayBatches)
              .where(eq(caseLawReplayBatches.sourceId, state.source.id))
          ).at(0);
          expect(failed).toMatchObject({
            failed: 1,
            attempts: 1,
            failureCode: "adapter-exception",
          });
          expect(failed?.retryAt).toEqual(
            new Date(state.now() + BACKGROUND_REPLAY_LIMITS.rowRetryBaseMs),
          );
          await tick({
            fixture: state,
            slot,
            canonical: { adapter },
            maxRows: 1,
          });
          expect(inspected).toHaveLength(1);
          expect(await cursor()).toBeUndefined();
          fail = false;
          state.advanceTime(BACKGROUND_REPLAY_LIMITS.rowRetryBaseMs);
          await tick({
            fixture: state,
            slot,
            canonical: { adapter },
            maxRows: 1,
          });
          expect(inspected).toEqual(["engine-0", "engine-0"]);
          expect(await cursor()).toBe(state.ids.at(0));
          expect(
            (
              await db
                .select()
                .from(caseLawReplayBatches)
                .where(eq(caseLawReplayBatches.sourceId, state.source.id))
            ).at(0),
          ).toMatchObject({ failed: 0, attempts: 2, retryAt: null });
          expect(
            await db
              .select()
              .from(caseLawReplayDailyRows)
              .where(eq(caseLawReplayDailyRows.sourceId, state.source.id)),
          ).toHaveLength(1);
          expect(
            await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.sourceId, state.source.id)),
          ).toEqual(before);
        },
      });
    });

    test("lease cleanup uses a fresh schema-lane handle and survives a concurrent exclusive upgrade", async () => {
      const state = await fixture(3);
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const upgrade = openClient();
        const cleanup = openClient();
        // The lease is taken before the upgrade holds the lane, so a short
        // budget is enough; a zero budget refuses even an uncontended grant.
        const acquireDb: ScopedDb = async (work) =>
          await runUnderCorpusSchemaLane({
            database: db,
            work,
            laneWaitMs: 1000,
          });
        const retryReached = Promise.withResolvers<undefined>();
        const resume = Promise.withResolvers<undefined>();
        const releaseDb: ScopedDb = async (work) =>
          await runUnderCorpusSchemaLane({
            database: cleanup.db,
            work,
            laneWaitMs: 1000,
            sleep: async () => {
              retryReached.resolve(undefined);
              await resume.promise;
            },
          });
        const lease = await acquireCaseLawSourceIngestionLease({
          scopedDb: acquireDb,
          sourceId: state.source.id,
          releaseDb,
        });
        if (lease === null) {
          panic("Expected available source lease");
        }
        await upgrade.sql.unsafe(CORPUS_SCHEMA_LANE_LOCK_SQL);
        const releasing = lease.release();
        try {
          await retryReached.promise;
          expect(
            (
              await db
                .select()
                .from(caseLawSources)
                .where(eq(caseLawSources.id, state.source.id))
            ).at(0)?.ingestionLeaseToken,
          ).toBe(lease.leaseToken);
        } finally {
          await upgrade.sql.unsafe(CORPUS_SCHEMA_LANE_UNLOCK_SQL);
          resume.resolve(undefined);
          await releasing;
        }
        expect(
          (
            await db
              .select()
              .from(caseLawSources)
              .where(eq(caseLawSources.id, state.source.id))
          ).at(0)?.ingestionLeaseToken,
        ).toBeNull();
        const next = await acquireCaseLawSourceIngestionLease({
          scopedDb,
          sourceId: state.source.id,
        });
        expect(next).not.toBeNull();
        await next?.release();
      });
    });

    test("a tick deadline cancels a held S3 read and releases the source lease and heavy slot after persisting failure", async () => {
      const state = await fixture(3);
      const id = state.ids.at(0);
      if (id === undefined) {
        panic("Expected first fixture decision");
      }
      const fake = startReplayFixtureStorage();
      fake.put(envBase.S3_BUCKET, `fixture/${id}`, "stored fixture bytes");
      const held = fake.holdNext({
        method: "GET",
        keyIncludes: `fixture/${id}`,
      });
      const controller = new AbortController();
      try {
        await withSlots({
          run: async ([slot, contender]) => {
            const running = Result.tryPromise(async () =>
              tick({
                fixture: state,
                slot,
                maxRows: 1,
                signal: AbortSignal.any([
                  controller.signal,
                  AbortSignal.timeout(3000),
                ]),
                canonical: { ...canonicalReplay(), readStoredRaw: "s3" },
              }),
            );
            try {
              await Promise.race([
                held.reached,
                running.then(() =>
                  panic(
                    "Expected the raw GET to remain in flight until deadline",
                  ),
                ),
              ]);
              controller.abort(
                new DOMException("fixture tick deadline", "TimeoutError"),
              );
              const result = await running;
              if (result.isErr()) {
                throw result.error;
              }
              expect(result.value).toMatchObject({
                status: "time-limit",
                attempted: 1,
                applied: 0,
                errors: 1,
              });
              const receipt = (
                await db
                  .select()
                  .from(caseLawReplayBatches)
                  .where(eq(caseLawReplayBatches.sourceId, state.source.id))
              ).at(0);
              expect(receipt).toMatchObject({
                status: "reserved",
                attempts: 0,
                failureCode: "tick-deadline",
                failureMessageClass: "deadline",
              });
              expect(receipt?.retryAt).not.toBeNull();
              expect(
                (
                  await db
                    .select()
                    .from(caseLawSources)
                    .where(eq(caseLawSources.id, state.source.id))
                ).at(0)?.ingestionLeaseToken,
              ).toBeNull();
              const acquired = await contender.tryAcquire();
              expect(acquired.isOk() && acquired.value).toBe(true);
              await contender.release();
              const lease = await acquireCaseLawSourceIngestionLease({
                scopedDb,
                sourceId: state.source.id,
              });
              expect(lease).not.toBeNull();
              await lease?.release();
            } finally {
              controller.abort();
              held.release();
              await running;
            }
          },
        });
      } finally {
        held.release();
        fake.stop();
      }
    });

    test("the tick signal cancels a real blocked database query and releases its maintenance lane", async () => {
      expect(envBase.DATABASE_URL).toBe(databaseUrl);
      const state = await fixture(3);
      const id = state.ids.at(0);
      if (id === undefined) {
        panic("Expected first fixture decision");
      }
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const blocker = openClient();
        const observer = openClient();
        const controller = new AbortController();
        const backend = Promise.withResolvers<number>();
        await blocker.sql.unsafe("BEGIN");
        await blocker.sql.unsafe(
          "SELECT id FROM case_law_decisions WHERE id = $1 FOR UPDATE",
          [id],
        );
        const running = Result.tryPromise(async () =>
          withLongRunningConnection(
            {
              statementTimeout: 10_000,
              lockTimeout: 10_000,
              signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(BLOCKED_QUERY_DEADLINE_MS * 3),
              ]),
            },
            async ({ connection }) => {
              await connection.unsafe(
                "SELECT pg_advisory_lock(hashtext($1), hashtext($2))",
                ["replay-deadline-fixture", state.source.id],
              );
              const pid = (
                await connection.unsafe<{ pid: number }[]>(
                  "SELECT pg_backend_pid() AS pid",
                )
              ).at(0)?.pid;
              if (pid === undefined) {
                panic("Expected dedicated replay backend");
              }
              backend.resolve(pid);
              await connection.unsafe(
                "UPDATE case_law_decisions SET parser_version = 2 WHERE id = $1",
                [id],
              );
            },
          ),
        );
        try {
          const pid = await Promise.race([
            backend.promise,
            running.then(() =>
              panic("Expected blocked dedicated replay backend"),
            ),
          ]);
          // The backend reports its pid before it sends the UPDATE, so wait
          // for Postgres to show it waiting on the row lock.
          expect(
            await waitForState(async () => {
              const activity = await observer.sql.unsafe<
                { waiting: boolean }[]
              >(
                "SELECT wait_event_type = 'Lock' AS waiting FROM pg_stat_activity WHERE pid = $1",
                [pid],
              );
              return activity.at(0)?.waiting === true;
            }),
          ).toBe(true);
          controller.abort(
            new DOMException("fixture database deadline", "TimeoutError"),
          );
          const result = await running;
          expect(result.isErr()).toBe(true);
          if (result.isErr()) {
            expect(
              result.error instanceof Error
                ? result.error.message
                : JSON.stringify(result.error),
            ).toMatch(/cancel|abort|deadline/u);
          }
          // Session locks are released when the backend exits, which the
          // server finishes after the client has closed its connection.
          expect(
            await waitForState(async () => {
              const alive = await observer.sql.unsafe<{ pid: number }[]>(
                "SELECT pid FROM pg_stat_activity WHERE pid = $1",
                [pid],
              );
              return alive.length === 0;
            }),
          ).toBe(true);
          const acquired = await observer.sql.unsafe<{ acquired: boolean }[]>(
            "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired",
            ["replay-deadline-fixture", state.source.id],
          );
          expect(acquired.at(0)?.acquired).toBe(true);
          await observer.sql.unsafe(
            "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
            ["replay-deadline-fixture", state.source.id],
          );
          expect(
            (
              await db
                .select({ version: caseLawDecisions.parserVersion })
                .from(caseLawDecisions)
                .where(eq(caseLawDecisions.id, id))
            ).at(0)?.version,
          ).toBe(1);
        } finally {
          controller.abort();
          await blocker.sql.unsafe("ROLLBACK");
          await running;
        }
      });
    });

    test.each(["injected", "real"] as const)(
      "the scheduled wiring uses %s indicators and stored raw on its dedicated ingestion session",
      async (readerMode) => {
        expect(envBase.DATABASE_URL).toBe(databaseUrl);
        expect(
          envDbLoadGate.DB_LOAD_GATE_RDS_INSTANCE_IDENTIFIER,
        ).toBeUndefined();
        expect(envDbLoadGate.DB_LOAD_GATE_EBS_SIGNAL).toBe("disabled");
        const state = await fixture(3);
        const id = state.ids.at(0);
        if (id === undefined) {
          panic("Expected first fixture decision");
        }
        await db
          .update(caseLawSources)
          .set({ adapterKey: ADAPTER_KEYS.EU_ECJ })
          .where(eq(caseLawSources.id, state.source.id));
        const oldEnabled = process.env["CASE_LAW_REPLAY_ENABLED"];
        const oldKill = process.env["CASE_LAW_REPLAY_KILL_SWITCH"];
        const oldDisabled = process.env["CASE_LAW_REPLAY_DISABLED_SOURCES"];
        process.env["CASE_LAW_REPLAY_ENABLED"] = "true";
        process.env["CASE_LAW_REPLAY_KILL_SWITCH"] = "false";
        process.env["CASE_LAW_REPLAY_DISABLED_SOURCES"] = "";
        const fake = startReplayFixtureStorage();
        fake.put(
          envBase.S3_BUCKET,
          `fixture/${id}`,
          "<html>stored fixture judgment</html>",
          "text/html",
        );
        const roles: string[] = [];
        const rootRoles: string[] = [];
        try {
          const canonical = canonicalReplay(
            false,
            PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ],
          );
          const enrolment = {
            ...REPLAY_ENROLMENT,
            [ADAPTER_KEYS.EU_ECJ]: {
              mode: "enrolled",
              dailyBudget: 3,
              reviewedDryRun: "fixture",
            },
          } as const;
          const result = await runReplayTickFixture(
            AbortSignal.timeout(10_000),
            {
              enrolment,
              maxRows: 1,
              healthConfig: { busyWindows: [] },
              adapterFor: () => canonical.adapter,
              ...(readerMode === "injected"
                ? {
                    readStoredRaw: async () =>
                      new TextEncoder().encode(
                        "<html>stored fixture judgment</html>",
                      ),
                    gate: async () => healthy(),
                  }
                : {}),
              onIngestionTransaction: async (tx) => {
                roles.push(
                  (
                    await tx.execute<{ role: string }>(
                      sql`SELECT current_user AS role`,
                    )
                  ).at(0)?.role ?? "missing",
                );
              },
              onRootTransaction: async (tx) => {
                rootRoles.push(
                  (
                    await tx.execute<{ role: string }>(
                      sql`SELECT current_user AS role`,
                    )
                  ).at(0)?.role ?? "missing",
                );
              },
            },
          );
          expect(result).toMatchObject({ applied: 1, blocked: 0, errors: 0 });
          if (readerMode === "real") {
            expect(
              fake.requests.some(
                (request) =>
                  request.method === "GET" && request.key === `fixture/${id}`,
              ),
            ).toBe(true);
          }
          expect(roles.length).toBeGreaterThan(3);
          expect(roles.every((role) => role === "stella_ingestion")).toBe(true);
          expect(rootRoles.length).toBeGreaterThan(1);
          expect(
            rootRoles.every(
              (role) => role !== "stella_ingestion" && role !== "missing",
            ),
          ).toBe(true);
          const row = (
            await db
              .select()
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, id))
          ).at(0);
          expect(row).toMatchObject({
            parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ],
            fulltext: "Fixture judgment rederived from stored bytes.",
            corpusMirrorStatus: "settled",
          });
          expect(row?.sourceRawS3Key).not.toBe(`fixture/${id}`);
          expect(
            (
              await db
                .select()
                .from(caseLawReplayBatches)
                .where(eq(caseLawReplayBatches.sourceId, state.source.id))
            ).at(0),
          ).toMatchObject({ status: "completed", applied: 1, attempts: 1 });
          expect(
            fake.requests.some((request) => request.method === "PUT"),
          ).toBe(true);
          expect(
            (
              await db
                .select()
                .from(caseLawSources)
                .where(eq(caseLawSources.id, state.source.id))
            ).at(0)?.ingestionLeaseToken,
          ).toBeNull();
        } finally {
          fake.stop();
          if (oldEnabled === undefined) {
            delete process.env["CASE_LAW_REPLAY_ENABLED"];
          } else {
            process.env["CASE_LAW_REPLAY_ENABLED"] = oldEnabled;
          }
          if (oldKill === undefined) {
            delete process.env["CASE_LAW_REPLAY_KILL_SWITCH"];
          } else {
            process.env["CASE_LAW_REPLAY_KILL_SWITCH"] = oldKill;
          }
          if (oldDisabled === undefined) {
            delete process.env["CASE_LAW_REPLAY_DISABLED_SOURCES"];
          } else {
            process.env["CASE_LAW_REPLAY_DISABLED_SOURCES"] = oldDisabled;
          }
          await db
            .delete(databaseBackfillStates)
            .where(
              eq(
                databaseBackfillStates.name,
                `case-law-replay:${state.source.id}:${PARSER_VERSIONS[ADAPTER_KEYS.EU_ECJ]}`,
              ),
            );
          await db
            .update(caseLawSources)
            .set({ adapterKey: `engine-${state.source.id}` })
            .where(eq(caseLawSources.id, state.source.id));
        }
      },
    );

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

    test("index build and repair intents let the current replay row finish and prevent another reservation", async () => {
      for (const contenderKind of ["index_build", "index_repair"] as const) {
        const state = await fixture(3);
        const firstId = state.ids.at(0);
        if (firstId === undefined) {
          throw new TypeError("Expected first replay decision");
        }
        await withSlots({
          contenderKind,
          run: async ([replaySlot, indexSlot]) => {
            const acquire = async (slot: typeof replaySlot) => {
              const result = await slot.tryAcquire();
              if (result.isErr()) {
                throw result.error;
              }
              return result.value;
            };
            let batches = 0;
            const report = await tick({
              fixture: state,
              slot: replaySlot,
              beforeReplay: async () => {
                batches += 1;
                expect(await acquire(indexSlot)).toBe(false);
                expect((await state.checkpoint())?.cursor).toBeNull();
              },
            });
            expect(batches).toBe(1);
            expect(report).toMatchObject({
              status: "slot-unavailable",
              attempted: 1,
              applied: 1,
            });
            expect((await state.checkpoint())?.cursor).toBe(state.ids.at(0));
            const receipts = await db
              .select()
              .from(caseLawReplayBatches)
              .where(eq(caseLawReplayBatches.sourceId, state.source.id));
            expect(receipts).toHaveLength(1);
            expect(receipts.at(0)).toMatchObject({
              status: "completed",
              firstDecisionId: state.ids.at(0),
            });
            expect(
              await db
                .select()
                .from(caseLawReplayDailyRows)
                .where(eq(caseLawReplayDailyRows.sourceId, state.source.id)),
            ).toHaveLength(1);
            const decisions = await db
              .select({
                id: caseLawDecisions.id,
                parserVersion: caseLawDecisions.parserVersion,
              })
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.sourceId, state.source.id));
            expect(
              decisions
                .filter(({ parserVersion }) => parserVersion === 2)
                .map(({ id }) => id),
            ).toEqual([firstId]);
            expect(await acquire(indexSlot)).toBe(true);
            const held = await tick({ fixture: state, slot: replaySlot });
            expect(held).toMatchObject({
              status: "slot-unavailable",
              attempted: 0,
              applied: 0,
            });
            expect(
              await db
                .select()
                .from(caseLawReplayBatches)
                .where(eq(caseLawReplayBatches.sourceId, state.source.id)),
            ).toEqual(receipts);
            expect((await state.checkpoint())?.cursor).toBe(state.ids.at(0));
            await indexSlot.close();
            const resumed = await tick({
              fixture: state,
              slot: replaySlot,
              maxRows: 1,
            });
            expect(resumed.applied).toBe(1);
            expect((await state.checkpoint())?.cursor).toBe(state.ids.at(1));
          },
        });
      }
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
