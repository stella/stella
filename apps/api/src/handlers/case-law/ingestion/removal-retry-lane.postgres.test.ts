/**
 * Publisher removal retries have a dedicated durable lane. Run only
 * against the migrated Postgres test database; skipped elsewhere.
 */
import { describe, expect, test } from "bun:test";
import { and, eq, getTableName, isNull, sql } from "drizzle-orm";

import { createScriptBackfillRuntime } from "@/api/db/backfill-runtime";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawReconciliationItems,
  caseLawRemovalReconciliationItems,
  caseLawSources,
  publishedCaseLawDecisions,
  RECONCILIATION_ITEM_STATUS,
  schedulerJobs,
} from "@/api/db/schema";
import { createIngestionDb, markRlsDatabase } from "@/api/db/scoped";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import { PublisherRateLimitRefusalError } from "@/api/handlers/case-law/ingestion/adapters/retry";
import { probeUkFclRemoval } from "@/api/handlers/case-law/ingestion/adapters/uk-fcl-removal";
import { getIngestionStatus } from "@/api/handlers/case-law/ingestion/get";
import {
  reconcilePublisherRemovals,
  REMOVAL_RECONCILIATION_CONFIG_KEY,
  REMOVAL_RETRY_PER_KIND_BUDGET,
} from "@/api/handlers/case-law/ingestion/removal-reconciliation";
import type { PublisherRemovalRead } from "@/api/handlers/case-law/ingestion/removal-reconciliation";
import { redactCaseLawDecisionWithSupplementHolders } from "@/api/handlers/case-law/ingestion/supplement-erasure";
import { removePublisherDecision } from "@/api/handlers/case-law/publisher-removal";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import type { CaseLawRawSweepOutcome } from "@/api/lib/legal-search/case-law-raw-sweeps";
import { selectDueReconciliationItems } from "@/api/lib/legal-search/reconciliation-store";
import {
  REMOVAL_PENDING_REASON,
  REMOVAL_RETRY_KIND,
} from "@/api/lib/legal-search/removal-reconciliation-state";
import type { RemovalCheckpoint } from "@/api/lib/legal-search/removal-reconciliation-state";
import { selectDueErasureSources } from "@/api/lib/legal-search/removal-reconciliation-store";
import { logger } from "@/api/lib/observability/logger";
import { DueSlot } from "@/api/lib/scheduler/due-slot";
import {
  createReconcileClaimedErasuresTask,
  RECONCILE_CLAIMED_ERASURES_TASK,
} from "@/api/lib/scheduler/tasks/case-law-publisher-removals";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { publisherRemovalProbe } from "@/api/tests/helpers/publisher-removal-probe";
import { asFetchMock, asTestRaw } from "@/api/tests/helpers/test-tool-set";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const FIXED_NOW = new Date("2026-10-27T12:00:00.000Z");

if (!databaseUrl || !runPostgresTests) {
  describe.skip("publisher removal retry lane (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("publisher removal retry lane (postgres)", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const ingestionDb = createIngestionDb(markRlsDatabase(db));
    const scopedDb: ScopedDb = async (callback) => await ingestionDb(callback);
    const sourceIds: SafeId<"caseLawSource">[] = [];

    cleanUp(async () => {
      for (const sourceId of sourceIds) {
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    });

    const insertSource = async (sourceId: SafeId<"caseLawSource">) => {
      sourceIds.push(sourceId);
      await db.insert(caseLawSources).values(
        caseLawSourceRow({
          id: sourceId,
          adapterKey: `removal-retry-${sourceId}`,
          name: "Publisher removal retry test source",
          config: {
            [REMOVAL_RECONCILIATION_CONFIG_KEY]: { status: "enabled" },
          },
        }),
      );
    };

    const insertDecision = async (options: {
      id: SafeId<"caseLawDecision">;
      sourceId: SafeId<"caseLawSource">;
      sourceDocumentId: string | null;
      ordinal: string;
    }) =>
      await db.insert(caseLawDecisions).values({
        id: options.id,
        sourceId: options.sourceId,
        sourceDocumentId: options.sourceDocumentId,
        caseNumber: `[2024] UKSC ${options.ordinal}`,
        country: "GBR",
        court: "UKSC",
        language: "en",
        fulltext: "decision text",
      });

    const setCheckpoint = async (
      sourceId: SafeId<"caseLawSource">,
      checkpoint: RemovalCheckpoint,
    ) =>
      await db
        .update(caseLawSources)
        .set({ removalCheckpoint: checkpoint })
        .where(eq(caseLawSources.id, sourceId));

    const reconcile = async ({
      sourceId,
      now,
      probe,
      remove,
    }: {
      sourceId: SafeId<"caseLawSource">;
      now: Date;
      probe: ReturnType<typeof publisherRemovalProbe>;
      remove?: Parameters<typeof reconcilePublisherRemovals>[0]["remove"];
    }) =>
      await reconcilePublisherRemovals({
        scopedDb,
        sourceId,
        signal: AbortSignal.timeout(10_000),
        now: () => now,
        probe,
        ...(remove === undefined ? {} : { remove }),
      });

    const makeRemove =
      (
        sweepRaw: (
          decisionId: SafeId<"caseLawDecision">,
        ) => Promise<CaseLawRawSweepOutcome>,
      ) =>
      async (options: Parameters<typeof removePublisherDecision>[0]) =>
        await removePublisherDecision({
          ...options,
          redact: async (redactOptions) =>
            await redactCaseLawDecisionWithSupplementHolders({
              ...redactOptions,
              redactDecision: async (decisionOptions) =>
                await redactCaseLawDecision({
                  ...decisionOptions,
                  sweepRaw: async ({ decisionId }) =>
                    await sweepRaw(decisionId),
                }),
            }),
        });

    test.each(["publisher-discovery", "claimed-erasures"] as const)(
      "accepted erasures complete without a probe in %s",
      async (mode) => {
        const sourceId = createSafeId<"caseLawSource">();
        const decisionId = createSafeId<"caseLawDecision">();
        await insertSource(sourceId);
        await insertDecision({
          id: decisionId,
          sourceId,
          sourceDocumentId: "manual/1",
          ordinal: "manual",
        });
        await db
          .update(caseLawSources)
          .set({
            config: {},
            removalCheckpoint: {
              status: "paused",
              resumeAt: "2099-01-01T00:00:00.000Z",
              resume: null,
            },
          })
          .where(eq(caseLawSources.id, sourceId));
        await db
          .update(caseLawDecisions)
          .set({ redactedAt: FIXED_NOW, fulltext: null })
          .where(eq(caseLawDecisions.id, decisionId));
        await db.insert(caseLawRemovalReconciliationItems).values({
          sourceId,
          decisionId,
          kind: REMOVAL_RETRY_KIND.ERASURE,
          payload: {
            type: "pending",
            operation: "erase",
            decisionId,
            reason: REMOVAL_PENDING_REASON.STORES_PENDING,
            evidence: {
              type: "existing-redaction",
              decisionId,
              sourceId,
              sourceDocumentId: "manual/1",
              sourceObservedAt: null,
              sourceObservationOrder: null,
              observedAt: FIXED_NOW.toISOString(),
            },
          },
          nextAttemptAt: FIXED_NOW,
          lastAttemptAt: FIXED_NOW,
          lastError: REMOVAL_PENDING_REASON.STORES_PENDING,
        });
        const pendingId = createSafeId<"caseLawDecision">();
        await insertDecision({
          id: pendingId,
          sourceId,
          sourceDocumentId: "publisher/2",
          ordinal: "pending",
        });
        await db.insert(caseLawRemovalReconciliationItems).values({
          sourceId,
          decisionId: pendingId,
          kind: REMOVAL_RETRY_KIND.ERASURE,
          payload: {
            type: "pending",
            operation: "erase",
            decisionId: pendingId,
            reason: REMOVAL_PENDING_REASON.PUBLISHER_ABSENT,
            evidence: {
              type: "publisher-absence",
              decisionId: pendingId,
              sourceId,
              sourceDocumentId: "publisher/2",
              sourceObservedAt: null,
              sourceObservationOrder: null,
              observedAt: FIXED_NOW.toISOString(),
              absence: "publisher-typed-absence",
            },
          },
          nextAttemptAt: new Date(FIXED_NOW.getTime() - 1000),
          lastAttemptAt: FIXED_NOW,
          lastError: REMOVAL_PENDING_REASON.PUBLISHER_ABSENT,
        });
        expect(
          await selectDueErasureSources({
            scopedDb,
            after: null,
            now: FIXED_NOW,
            limit: 1,
          }),
        ).toEqual([{ id: sourceId }]);
        expect(
          await selectDueErasureSources({
            scopedDb,
            after: sourceId,
            now: FIXED_NOW,
            limit: 1,
          }),
        ).toEqual([]);
        let erased = 0;
        const run = async (
          options: Parameters<typeof reconcilePublisherRemovals>[0],
        ) =>
          await reconcilePublisherRemovals({
            ...options,
            now: () => FIXED_NOW,
            remove: makeRemove(async () => {
              erased++;
              return { type: "swept", legacy: "none" };
            }),
          });
        if (mode === "publisher-discovery") {
          expect(
            (
              await run({
                scopedDb,
                sourceId,
                signal: AbortSignal.timeout(10_000),
              })
            ).unwrap().retried,
          ).toBe(1);
        } else {
          const jobId = `erasure-retry-${sourceId}`;
          const job = (
            await db
              .insert(schedulerJobs)
              .values({
                id: jobId,
                task: RECONCILE_CLAIMED_ERASURES_TASK,
                schedule: { type: "interval", everyMs: 60_000 },
                payload: { cursor: null },
                nextRunAt: FIXED_NOW,
                lockedAt: FIXED_NOW,
                lockedBy: "erasure-fixture",
              })
              .returning()
          ).at(0);
          if (job === undefined) {
            throw new Error("Missing erasure retry job");
          }
          const task = createReconcileClaimedErasuresTask({
            scopedDb,
            reconcile: run,
            createRuntime: (options) =>
              createScriptBackfillRuntime({
                ...options,
                readVerdict: async () => ({ kind: "normal", signals: [] }),
              }),
          });
          const continuations: Date[] = [];
          try {
            const result = await task(
              asTestRaw<Parameters<typeof task>[0]>({
                db,
                job,
                payload: job.payload,
                dueAt: DueSlot.of(job),
                runId: createSafeId<"schedulerJobRun">(),
                signal: AbortSignal.timeout(10_000),
                logger,
                scheduleContinuation: (at: Date) => continuations.push(at),
              }),
            );
            expect(result?.isOk()).toBe(true);
            expect(continuations).toEqual([
              new Date(FIXED_NOW.getTime() + 1000),
            ]);
            expect(
              (
                await db
                  .select({ payload: schedulerJobs.payload })
                  .from(schedulerJobs)
                  .where(eq(schedulerJobs.id, jobId))
              ).at(0)?.payload,
            ).toEqual({ cursor: sourceId });
          } finally {
            await db.delete(schedulerJobs).where(eq(schedulerJobs.id, jobId));
          }
        }
        expect(erased).toBe(1);
        expect(
          await db.$count(
            caseLawRemovalReconciliationItems,
            eq(caseLawRemovalReconciliationItems.sourceId, sourceId),
          ),
        ).toBe(1);
        expect(
          (
            await db
              .select({ fulltext: caseLawDecisions.fulltext })
              .from(caseLawDecisions)
              .where(eq(caseLawDecisions.id, pendingId))
          ).at(0)?.fulltext,
        ).toBe("decision text");
        expect(
          await selectDueErasureSources({
            scopedDb,
            after: null,
            now: FIXED_NOW,
            limit: 1,
          }),
        ).toEqual([]);
      },
    );

    test("advances past a missing identity and retains one typed unprobeable retry", async () => {
      const sourceId = createSafeId<"caseLawSource">();
      const orderedDecisionIds = [
        createSafeId<"caseLawDecision">(),
        createSafeId<"caseLawDecision">(),
      ].toSorted();
      const missingId = orderedDecisionIds.at(0);
      const availableId = orderedDecisionIds.at(1);
      if (missingId === undefined || availableId === undefined) {
        throw new Error("Expected two decision IDs");
      }
      await insertSource(sourceId);
      await insertDecision({
        id: missingId,
        sourceId,
        sourceDocumentId: null,
        ordinal: "retry-missing",
      });
      await insertDecision({
        id: availableId,
        sourceId,
        sourceDocumentId: "uksc/2024/retry-present",
        ordinal: "retry-present",
      });
      const ceiling = availableId;
      await setCheckpoint(sourceId, {
        status: "running",
        cursor: null,
        ceiling,
      });

      const probes: string[] = [];
      let sweeps = 0;
      const first = await reconcile({
        sourceId,
        now: FIXED_NOW,
        probe: publisherRemovalProbe(async (identity) => {
          probes.push(identity);
          return { type: "absent", evidence: "publisher-typed-absence" };
        }),
        remove: makeRemove(async () => {
          sweeps++;
          return { type: "swept", legacy: "none" };
        }),
      });
      expect(first.unwrap()).toMatchObject({
        type: "complete",
        checked: 2,
        retried: 1,
      });
      expect(probes).toEqual([
        "uksc/2024/retry-present",
        "uksc/2024/retry-present",
      ]);
      expect(sweeps).toBe(1);
      expect(
        await db
          .select({ id: publishedCaseLawDecisions.id })
          .from(publishedCaseLawDecisions)
          .where(eq(publishedCaseLawDecisions.id, availableId)),
      ).toEqual([]);
      expect(
        await db
          .select({ redactedAt: caseLawDecisions.redactedAt })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, availableId)),
      ).toMatchObject([{ redactedAt: expect.any(Date) }]);

      const identityDecisionId = missingId;
      const retry = await db
        .select()
        .from(caseLawRemovalReconciliationItems)
        .where(
          and(
            eq(caseLawRemovalReconciliationItems.sourceId, sourceId),
            eq(
              caseLawRemovalReconciliationItems.decisionId,
              identityDecisionId,
            ),
          ),
        );
      expect(retry).toHaveLength(1);
      expect(retry.at(0)).toMatchObject({
        kind: REMOVAL_RETRY_KIND.UNPROBEABLE,
        attempts: 1,
        nextAttemptAt: new Date(FIXED_NOW.getTime() + 60_000),
        payload: {
          type: "unprobeable",
          decisionId: missingId,
          reason: "missing-source-document-id",
        },
      });

      const retried = await reconcile({
        sourceId,
        now: new Date(FIXED_NOW.getTime() + 60_000),
        probe: publisherRemovalProbe(async (identity) => {
          probes.push(identity);
          return { type: "present", value: null };
        }),
      });
      expect(retried.unwrap()).toMatchObject({
        type: "not-due",
        checked: 0,
        retried: 1,
      });
      expect(probes).toEqual([
        "uksc/2024/retry-present",
        "uksc/2024/retry-present",
      ]);
      const persisted = await db
        .select()
        .from(caseLawRemovalReconciliationItems)
        .where(
          and(
            eq(caseLawRemovalReconciliationItems.sourceId, sourceId),
            eq(
              caseLawRemovalReconciliationItems.decisionId,
              identityDecisionId,
            ),
          ),
        );
      expect(persisted).toHaveLength(1);
      expect(persisted.at(0)).toMatchObject({
        kind: REMOVAL_RETRY_KIND.UNPROBEABLE,
        attempts: 2,
        payload: {
          type: "unprobeable",
          decisionId: missingId,
          reason: "missing-source-document-id",
        },
      });
      const health = await getIngestionStatus(scopedDb, { now: FIXED_NOW });
      expect(
        health.sources.find(
          ({ adapterKey }) => adapterKey === `removal-retry-${sourceId}`,
        ),
      ).toMatchObject({
        reconciliation: { pendingRemovals: 1, unprobeable: 1 },
      });
    });

    test("continues past pending legacy erasure, removes the next absent decision, then settles once", async () => {
      const sourceId = createSafeId<"caseLawSource">();
      const orderedDecisionIds = [
        createSafeId<"caseLawDecision">(),
        createSafeId<"caseLawDecision">(),
      ].toSorted();
      const firstDecisionId = orderedDecisionIds.at(0);
      const secondDecisionId = orderedDecisionIds.at(1);
      if (firstDecisionId === undefined || secondDecisionId === undefined) {
        throw new Error("Expected two decision IDs");
      }
      await insertSource(sourceId);
      await insertDecision({
        id: firstDecisionId,
        sourceId,
        sourceDocumentId: "uksc/2024/retry-legacy-pending",
        ordinal: "retry-legacy-pending",
      });
      await insertDecision({
        id: secondDecisionId,
        sourceId,
        sourceDocumentId: "uksc/2024/retry-legacy-settled",
        ordinal: "retry-legacy-settled",
      });
      await setCheckpoint(sourceId, {
        status: "running",
        cursor: null,
        ceiling: secondDecisionId,
      });

      let probes = 0;
      let sweeps = 0;
      let firstLegacyPending = true;
      const remove = makeRemove(async (removedDecisionId) => {
        sweeps++;
        const legacyPending =
          removedDecisionId === firstDecisionId && firstLegacyPending;
        return { type: "swept", legacy: legacyPending ? "pending" : "none" };
      });
      const first = await reconcile({
        sourceId,
        now: FIXED_NOW,
        remove,
        probe: publisherRemovalProbe(async () => {
          probes++;
          return { type: "absent", evidence: "publisher-typed-absence" };
        }),
      });
      expect(first.unwrap()).toMatchObject({
        type: "complete",
        checked: 2,
        retried: 2,
      });
      expect(probes).toBe(4);
      expect(sweeps).toBe(2);

      const identityDecisionId = firstDecisionId;
      const queued = await db
        .select()
        .from(caseLawRemovalReconciliationItems)
        .where(
          and(
            eq(caseLawRemovalReconciliationItems.sourceId, sourceId),
            eq(
              caseLawRemovalReconciliationItems.decisionId,
              identityDecisionId,
            ),
          ),
        );
      expect(queued).toHaveLength(1);
      expect(queued.at(0)).toMatchObject({
        kind: REMOVAL_RETRY_KIND.ERASURE,
        attempts: 1,
        payload: {
          type: "pending",
          operation: "erase",
          decisionId: firstDecisionId,
          reason: REMOVAL_PENDING_REASON.STORES_PENDING,
        },
      });
      await setCheckpoint(sourceId, {
        status: "running",
        cursor: null,
        ceiling: firstDecisionId,
      });
      const rediscovered = await reconcile({
        sourceId,
        now: FIXED_NOW,
        remove,
        probe: publisherRemovalProbe(async () => ({
          type: "present",
          value: null,
        })),
      });
      expect(rediscovered.unwrap()).toMatchObject({
        type: "complete",
        checked: 1,
        retried: 0,
      });
      expect(
        await db
          .select()
          .from(caseLawRemovalReconciliationItems)
          .where(
            and(
              eq(caseLawRemovalReconciliationItems.sourceId, sourceId),
              eq(
                caseLawRemovalReconciliationItems.decisionId,
                identityDecisionId,
              ),
            ),
          ),
      ).toEqual(queued);
      const pendingHealth = await getIngestionStatus(scopedDb, {
        now: FIXED_NOW,
      });
      expect(
        pendingHealth.sources.find(
          ({ adapterKey }) => adapterKey === `removal-retry-${sourceId}`,
        ),
      ).toMatchObject({
        reconciliation: { pendingRemovals: 1, unprobeable: 0 },
      });

      const secondPublicDecision = await db
        .select({ id: publishedCaseLawDecisions.id })
        .from(publishedCaseLawDecisions)
        .where(eq(publishedCaseLawDecisions.id, secondDecisionId));
      expect(secondPublicDecision).toEqual([]);
      firstLegacyPending = false;
      const retry = await reconcile({
        sourceId,
        now: new Date(FIXED_NOW.getTime() + 60_000),
        remove,
        probe: publisherRemovalProbe(async () => {
          probes++;
          return { type: "present", value: null };
        }),
      });
      expect(retry.unwrap()).toMatchObject({
        type: "not-due",
        checked: 0,
        retried: 1,
      });
      expect(probes).toBe(4);
      expect(sweeps).toBe(3);
      expect(
        await db
          .select({ id: caseLawRemovalReconciliationItems.id })
          .from(caseLawRemovalReconciliationItems)
          .where(
            and(
              eq(caseLawRemovalReconciliationItems.sourceId, sourceId),
              eq(
                caseLawRemovalReconciliationItems.decisionId,
                identityDecisionId,
              ),
            ),
          ),
      ).toEqual([]);
      const replay = await reconcile({
        sourceId,
        now: new Date(FIXED_NOW.getTime() + 60_000),
        remove,
        probe: publisherRemovalProbe(async () => {
          probes++;
          return { type: "present", value: null };
        }),
      });
      expect(replay.unwrap()).toMatchObject({
        type: "not-due",
        checked: 0,
        retried: 0,
      });
      expect(probes).toBe(4);
      expect(sweeps).toBe(3);
      expect(
        await db
          .select({ id: caseLawDecisions.id })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.id, firstDecisionId)),
      ).toHaveLength(1);
      expect(
        await db
          .select({ id: caseLawDecisions.id })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.id, firstDecisionId),
              isNull(caseLawDecisions.redactedAt),
            ),
          ),
      ).toEqual([]);
      expect(
        await db
          .select({ id: publishedCaseLawDecisions.id })
          .from(publishedCaseLawDecisions)
          .where(eq(publishedCaseLawDecisions.id, firstDecisionId)),
      ).toEqual([]);
      const health = await getIngestionStatus(scopedDb, { now: FIXED_NOW });
      expect(
        health.sources.find(
          ({ adapterKey }) => adapterKey === `removal-retry-${sourceId}`,
        ),
      ).toMatchObject({
        reconciliation: null,
      });
    });

    test("a source refusal advances discovery and holds all publisher reads until its deadline", async () => {
      const sourceId = createSafeId<"caseLawSource">();
      await insertSource(sourceId);
      const firstId = createSafeId<"caseLawDecision">();
      const secondId = createSafeId<"caseLawDecision">();
      await insertDecision({
        id: firstId,
        sourceId,
        sourceDocumentId: "uksc/2024/source-refused",
        ordinal: "source-refused",
      });
      await insertDecision({
        id: secondId,
        sourceId,
        sourceDocumentId: "uksc/2024/source-after",
        ordinal: "source-after",
      });
      await setCheckpoint(sourceId, {
        status: "running",
        cursor: null,
        ceiling: secondId,
      });
      const resumeAt = new Date(FIXED_NOW.getTime() + 30_000 + 2 * 3_600_000);
      let currentTime = FIXED_NOW;
      let probes = 0;
      const probe = publisherRemovalProbe(
        async (identity: string): Promise<PublisherRemovalRead> => {
          probes++;
          if (identity.endsWith("source-refused")) {
            currentTime = new Date(FIXED_NOW.getTime() + 30_000);
            const originalFetch = globalThis.fetch;
            globalThis.fetch = asFetchMock(
              async () =>
                new Response("rate limit", {
                  status: 429,
                  headers: { "Retry-After": "7200" },
                }),
            );
            const observed = await probeUkFclRemoval(
              "uksc/2024/1",
              new AbortController().signal,
            );
            globalThis.fetch = originalFetch;
            if (observed.isErr()) {
              throw observed.error;
            }
            return observed.value;
          }
          return { type: "absent", evidence: "publisher-typed-absence" };
        },
      );
      const paused = await reconcilePublisherRemovals({
        scopedDb,
        sourceId,
        signal: new AbortController().signal,
        now: () => currentTime,
        probe,
      });
      expect(paused.unwrap()).toMatchObject({
        type: "paused",
        checked: 1,
        retried: 0,
        nextRetryAt: resumeAt,
      });
      const checkpoint = (
        await db
          .select({ state: caseLawSources.removalCheckpoint })
          .from(caseLawSources)
          .where(eq(caseLawSources.id, sourceId))
      ).at(0)?.state;
      expect(checkpoint).toEqual({
        status: "paused",
        resumeAt: resumeAt.toISOString(),
        resume: { status: "running", cursor: firstId, ceiling: secondId },
      });
      const held = await reconcile({
        sourceId,
        now: new Date(resumeAt.getTime() - 1),
        probe,
      });
      expect(held.unwrap()).toMatchObject({
        type: "paused",
        checked: 0,
        retried: 0,
        nextRetryAt: resumeAt,
      });
      expect(probes).toBe(1);
      let erasures = 0;
      const resumed = await reconcile({
        sourceId,
        now: resumeAt,
        probe: publisherRemovalProbe(async (identity) => {
          probes++;
          return identity.endsWith("source-after")
            ? { type: "absent", evidence: "publisher-typed-absence" }
            : { type: "present", value: null };
        }),
        remove: makeRemove(async () => {
          erasures++;
          return { type: "swept", legacy: "none" };
        }),
      });
      expect(resumed.unwrap()).toMatchObject({
        type: "complete",
        checked: 1,
        retried: 2,
        nextRetryAt: null,
      });
      expect(erasures).toBe(1);
      expect(probes).toBe(4);
      expect(
        await db
          .select({ id: publishedCaseLawDecisions.id })
          .from(publishedCaseLawDecisions)
          .where(eq(publishedCaseLawDecisions.id, secondId)),
      ).toEqual([]);
      expect(
        await db
          .select({ id: caseLawRemovalReconciliationItems.id })
          .from(caseLawRemovalReconciliationItems)
          .where(eq(caseLawRemovalReconciliationItems.sourceId, sourceId)),
      ).toEqual([]);
    });

    test("a source refusal during a document retry preserves the waiting checkpoint", async () => {
      const sourceId = createSafeId<"caseLawSource">();
      await insertSource(sourceId);
      const decisionId = createSafeId<"caseLawDecision">();
      await insertDecision({
        id: decisionId,
        sourceId,
        sourceDocumentId: "uksc/2024/retry-refused",
        ordinal: "retry-refused",
      });
      const first = await reconcile({
        sourceId,
        now: FIXED_NOW,
        probe: publisherRemovalProbe(async () => ({
          type: "refused",
          scope: "document",
          status: 403,
          cause: { kind: "http-status", retryAfter: null },
        })),
      });
      expect(first.unwrap()).toMatchObject({
        type: "complete",
        checked: 1,
        retried: 0,
      });
      const attemptAt = new Date(FIXED_NOW.getTime() + 60_000);
      const retry = await reconcile({
        sourceId,
        now: attemptAt,
        probe: publisherRemovalProbe(async () => {
          throw new PublisherRateLimitRefusalError({
            adapterKey: "uk-fcl",
            publisherKey: "fcl-uk",
            status: 429,
            cursor: null,
            retryAfter: "7200",
            cooldownUntilEpochMs: attemptAt.getTime() + 15 * 60_000,
          });
        }),
      });
      const resumeAt = new Date(attemptAt.getTime() + 2 * 3_600_000);
      expect(retry.unwrap()).toMatchObject({
        type: "paused",
        checked: 0,
        retried: 1,
        nextRetryAt: resumeAt,
      });
      const checkpoint = (
        await db
          .select({ state: caseLawSources.removalCheckpoint })
          .from(caseLawSources)
          .where(eq(caseLawSources.id, sourceId))
      ).at(0)?.state;
      expect(checkpoint).toMatchObject({
        status: "paused",
        resume: { status: "waiting" },
      });
      const resumed = await reconcile({
        sourceId,
        now: resumeAt,
        probe: publisherRemovalProbe(async () => ({
          type: "present",
          value: null,
        })),
      });
      expect(resumed.unwrap()).toMatchObject({
        type: "not-due",
        retried: 1,
        nextRetryAt: null,
      });
    });

    test("listing due-selection cannot see removal retries without a kind filter", async () => {
      const sourceId = createSafeId<"caseLawSource">();
      await insertSource(sourceId);
      const decisionId = createSafeId<"caseLawDecision">();
      await insertDecision({
        id: decisionId,
        sourceId,
        sourceDocumentId: null,
        ordinal: "separate-lane",
      });
      const queued = await reconcile({
        sourceId,
        now: FIXED_NOW,
        probe: publisherRemovalProbe(async () => ({
          type: "present",
          value: null,
        })),
      });
      expect(queued.unwrap()).toMatchObject({ checked: 1, retried: 0 });
      const listingId = createSafeId<"caseLawReconciliationItem">();
      const dueAt = new Date(FIXED_NOW.getTime() + 60_000);
      await db.insert(caseLawReconciliationItems).values({
        id: listingId,
        sourceId,
        slice: "listing",
        identityKey: "document:listing-only",
        payload: { sourceDocumentId: "listing-only" },
        nextAttemptAt: dueAt,
      });
      const current = await selectDueReconciliationItems(scopedDb, {
        sourceId,
        now: dueAt,
        limit: 10,
      });
      expect(current.map(({ id }) => id)).toEqual([listingId]);
      // The previous release selects directly from this table with no discriminator.
      const previousRelease = await scopedDb(
        async (tx) =>
          await tx
            .select({ id: caseLawReconciliationItems.id })
            .from(caseLawReconciliationItems)
            .where(
              and(
                eq(caseLawReconciliationItems.sourceId, sourceId),
                eq(
                  caseLawReconciliationItems.status,
                  RECONCILIATION_ITEM_STATUS.PARKED,
                ),
                sql`${caseLawReconciliationItems.nextAttemptAt} <= ${dueAt.toISOString()}::timestamptz`,
              ),
            )
            .limit(10),
      );
      expect(previousRelease).toEqual([{ id: listingId }]);
      expect(
        await db
          .select({ decisionId: caseLawRemovalReconciliationItems.decisionId })
          .from(caseLawRemovalReconciliationItems)
          .where(eq(caseLawRemovalReconciliationItems.sourceId, sourceId)),
      ).toEqual([{ decisionId }]);
    });

    test("bounded retries leave the remainder due for the next run", async () => {
      const sourceId = createSafeId<"caseLawSource">();
      await insertSource(sourceId);
      const count = REMOVAL_RETRY_PER_KIND_BUDGET + 1;
      await db.insert(caseLawDecisions).values(
        Array.from({ length: count }, (_, index) => ({
          id: createSafeId<"caseLawDecision">(),
          sourceId,
          sourceDocumentId: null,
          caseNumber: `bounded-${index}`,
          country: "GBR",
          court: "UKSC",
          language: "en",
        })),
      );
      const probe = publisherRemovalProbe(
        async (): Promise<PublisherRemovalRead> => ({
          type: "present",
          value: null,
        }),
      );
      const discovered = await reconcile({ sourceId, now: FIXED_NOW, probe });
      expect(discovered.unwrap()).toMatchObject({
        type: "complete",
        checked: count,
        retried: 0,
      });
      const dueAt = new Date(FIXED_NOW.getTime() + 60_000);
      const first = await reconcile({ sourceId, now: dueAt, probe });
      expect(first.unwrap()).toMatchObject({
        checked: 0,
        retried: REMOVAL_RETRY_PER_KIND_BUDGET,
        nextRetryAt: dueAt,
      });
      const resumed = await reconcile({ sourceId, now: dueAt, probe });
      expect(resumed.unwrap()).toMatchObject({
        checked: 0,
        retried: 1,
        nextRetryAt: new Date(dueAt.getTime() + 5 * 60_000),
      });
      const items = await db
        .select({ attempts: caseLawRemovalReconciliationItems.attempts })
        .from(caseLawRemovalReconciliationItems)
        .where(eq(caseLawRemovalReconciliationItems.sourceId, sourceId));
      expect(items).toHaveLength(count);
      expect(items.every(({ attempts }) => attempts === 2)).toBe(true);
    });

    test("rolls back a retry item when its discovery checkpoint cannot commit", async () => {
      const sourceId = createSafeId<"caseLawSource">();
      const decisionId = createSafeId<"caseLawDecision">();
      await insertSource(sourceId);
      await insertDecision({
        id: decisionId,
        sourceId,
        sourceDocumentId: null,
        ordinal: "retry-atomic-rollback",
      });
      await setCheckpoint(sourceId, {
        status: "running",
        cursor: null,
        ceiling: decisionId,
      });

      const failCheckpointUpdate: ScopedDb = async (callback) =>
        await ingestionDb(async (tx) => {
          const update = tx.update.bind(tx);
          const intercepted = new Proxy(tx, {
            get(target, property, receiver) {
              if (property !== "update") {
                return Reflect.get(target, property, receiver);
              }
              return <T extends Parameters<typeof tx.update>[0]>(table: T) => {
                if (getTableName(table) === getTableName(caseLawSources)) {
                  throw new DatabaseError({
                    message: "synthetic checkpoint failure",
                  });
                }
                return update(table);
              };
            },
          });
          return await callback(asTestRaw<Transaction>(intercepted));
        });

      const failed = await reconcilePublisherRemovals({
        scopedDb: failCheckpointUpdate,
        sourceId,
        signal: AbortSignal.timeout(10_000),
        now: () => FIXED_NOW,
        probe: publisherRemovalProbe(async () => ({
          type: "present",
          value: null,
        })),
      });
      expect(
        failed.isErr() ? Bun.inspect(failed.error) : "unexpected success",
      ).toContain("synthetic checkpoint failure");
      expect(
        await db
          .select({ id: caseLawRemovalReconciliationItems.id })
          .from(caseLawRemovalReconciliationItems)
          .where(
            and(
              eq(caseLawRemovalReconciliationItems.sourceId, sourceId),
              eq(caseLawRemovalReconciliationItems.decisionId, decisionId),
            ),
          ),
      ).toEqual([]);
      expect(
        (
          await db
            .select({ removalCheckpoint: caseLawSources.removalCheckpoint })
            .from(caseLawSources)
            .where(eq(caseLawSources.id, sourceId))
        ).at(0)?.removalCheckpoint,
      ).toEqual({ status: "running", cursor: null, ceiling: decisionId });

      const replay = await reconcilePublisherRemovals({
        scopedDb,
        sourceId,
        signal: AbortSignal.timeout(10_000),
        now: () => FIXED_NOW,
        probe: publisherRemovalProbe(async () => ({
          type: "present",
          value: null,
        })),
      });
      expect(replay.unwrap()).toMatchObject({
        type: "complete",
        checked: 1,
        retried: 0,
      });
      expect(
        await db
          .select({
            id: caseLawRemovalReconciliationItems.id,
            kind: caseLawRemovalReconciliationItems.kind,
          })
          .from(caseLawRemovalReconciliationItems)
          .where(
            and(
              eq(caseLawRemovalReconciliationItems.sourceId, sourceId),
              eq(caseLawRemovalReconciliationItems.decisionId, decisionId),
            ),
          ),
      ).toMatchObject([{ kind: REMOVAL_RETRY_KIND.UNPROBEABLE }]);
      expect(
        (
          await db
            .select({ removalCheckpoint: caseLawSources.removalCheckpoint })
            .from(caseLawSources)
            .where(eq(caseLawSources.id, sourceId))
        ).at(0)?.removalCheckpoint,
      ).toMatchObject({ status: "waiting" });
    });
  });
}
