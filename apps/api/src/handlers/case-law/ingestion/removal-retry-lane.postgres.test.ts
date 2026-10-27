/**
 * Publisher removal retries share the durable reconciliation lane. Run only
 * against the migrated Postgres test database; skipped elsewhere.
 */
import { describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisions,
  caseLawReconciliationItems,
  caseLawSources,
  publishedCaseLawDecisions,
  RECONCILIATION_ITEM_STATUS,
} from "@/api/db/schema";
import { createIngestionDb, markRlsDatabase } from "@/api/db/scoped";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
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
import { REMOVAL_RETRY_KIND } from "@/api/lib/legal-search/removal-reconciliation-state";
import type { RemovalCheckpoint } from "@/api/lib/legal-search/removal-reconciliation-state";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

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
      probe: (
        identity: string,
        signal: AbortSignal,
      ) => Promise<PublisherRemovalRead>;
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
        probe: async (identity) => {
          probes.push(identity);
          return { type: "absent", evidence: "publisher-typed-absence" };
        },
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
      expect(probes).toEqual(["uksc/2024/retry-present"]);
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

      const identityKey = `removal:${missingId}`;
      const retry = await db
        .select()
        .from(caseLawReconciliationItems)
        .where(
          and(
            eq(caseLawReconciliationItems.sourceId, sourceId),
            eq(caseLawReconciliationItems.identityKey, identityKey),
          ),
        );
      expect(retry).toHaveLength(1);
      expect(retry.at(0)).toMatchObject({
        kind: REMOVAL_RETRY_KIND.UNPROBEABLE,
        status: RECONCILIATION_ITEM_STATUS.PARKED,
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
        probe: async (identity) => {
          probes.push(identity);
          return { type: "present", value: null };
        },
      });
      expect(retried.unwrap()).toMatchObject({
        type: "not-due",
        checked: 0,
        retried: 1,
      });
      expect(probes).toEqual(["uksc/2024/retry-present"]);
      const persisted = await db
        .select()
        .from(caseLawReconciliationItems)
        .where(
          and(
            eq(caseLawReconciliationItems.sourceId, sourceId),
            eq(caseLawReconciliationItems.identityKey, identityKey),
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
        probe: async () => {
          probes++;
          return { type: "absent", evidence: "publisher-typed-absence" };
        },
      });
      expect(first.unwrap()).toMatchObject({
        type: "complete",
        checked: 2,
        retried: 2,
      });
      expect(probes).toBe(2);
      expect(sweeps).toBe(2);

      const identityKey = `removal:${firstDecisionId}`;
      const queued = await db
        .select()
        .from(caseLawReconciliationItems)
        .where(
          and(
            eq(caseLawReconciliationItems.sourceId, sourceId),
            eq(caseLawReconciliationItems.identityKey, identityKey),
          ),
        );
      expect(queued).toHaveLength(1);
      expect(queued.at(0)).toMatchObject({
        kind: REMOVAL_RETRY_KIND.PENDING,
        status: RECONCILIATION_ITEM_STATUS.PARKED,
        attempts: 1,
        payload: {
          type: "pending",
          operation: "erase",
          decisionId: firstDecisionId,
          reason: "stores-pending",
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
        probe: async () => ({ type: "present", value: null }),
      });
      expect(rediscovered.unwrap()).toMatchObject({
        type: "complete",
        checked: 1,
        retried: 0,
      });
      expect(
        await db
          .select()
          .from(caseLawReconciliationItems)
          .where(
            and(
              eq(caseLawReconciliationItems.sourceId, sourceId),
              eq(caseLawReconciliationItems.identityKey, identityKey),
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
        probe: async () => {
          probes++;
          return { type: "present", value: null };
        },
      });
      expect(retry.unwrap()).toMatchObject({
        type: "not-due",
        checked: 0,
        retried: 1,
      });
      expect(probes).toBe(2);
      expect(sweeps).toBe(3);
      expect(
        await db
          .select({ id: caseLawReconciliationItems.id })
          .from(caseLawReconciliationItems)
          .where(
            and(
              eq(caseLawReconciliationItems.sourceId, sourceId),
              eq(caseLawReconciliationItems.identityKey, identityKey),
            ),
          ),
      ).toEqual([]);
      const replay = await reconcile({
        sourceId,
        now: new Date(FIXED_NOW.getTime() + 60_000),
        remove,
        probe: async () => {
          probes++;
          return { type: "present", value: null };
        },
      });
      expect(replay.unwrap()).toMatchObject({
        type: "not-due",
        checked: 0,
        retried: 0,
      });
      expect(probes).toBe(2);
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
      const probe = async (): Promise<PublisherRemovalRead> => ({
        type: "present",
        value: null,
      });
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
        .select({ attempts: caseLawReconciliationItems.attempts })
        .from(caseLawReconciliationItems)
        .where(eq(caseLawReconciliationItems.sourceId, sourceId));
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
                if (table === caseLawSources) {
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
        probe: async () => ({ type: "present", value: null }),
      });
      expect(
        failed.isErr() ? Bun.inspect(failed.error) : "unexpected success",
      ).toContain("synthetic checkpoint failure");
      expect(
        await db
          .select({ id: caseLawReconciliationItems.id })
          .from(caseLawReconciliationItems)
          .where(
            and(
              eq(caseLawReconciliationItems.sourceId, sourceId),
              eq(
                caseLawReconciliationItems.identityKey,
                `removal:${decisionId}`,
              ),
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
        probe: async () => ({ type: "present", value: null }),
      });
      expect(replay.unwrap()).toMatchObject({
        type: "complete",
        checked: 1,
        retried: 0,
      });
      expect(
        await db
          .select({
            id: caseLawReconciliationItems.id,
            kind: caseLawReconciliationItems.kind,
          })
          .from(caseLawReconciliationItems)
          .where(
            and(
              eq(caseLawReconciliationItems.sourceId, sourceId),
              eq(
                caseLawReconciliationItems.identityKey,
                `removal:${decisionId}`,
              ),
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
