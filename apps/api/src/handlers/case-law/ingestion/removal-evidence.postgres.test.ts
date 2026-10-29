import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionAliases,
  caseLawDecisions,
  caseLawRemovalReconciliationItems,
  caseLawSources,
  publishedCaseLawDecisions,
} from "@/api/db/schema";
import { createIngestionDb, markRlsDatabase } from "@/api/db/scoped";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import {
  reconcilePublisherRemovals,
  REMOVAL_SWEEP_TIME_BUDGET_MS,
} from "@/api/handlers/case-law/ingestion/removal-reconciliation";
import type { PublisherRemovalRead } from "@/api/handlers/case-law/ingestion/removal-reconciliation";
import { redactCaseLawDecisionWithSupplementHolders } from "@/api/handlers/case-law/ingestion/supplement-erasure";
import { removePublisherDecision } from "@/api/handlers/case-law/publisher-removal";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { REMOVAL_SUPERSEDED_REASON } from "@/api/lib/legal-search/removal-evidence";
import { REMOVAL_RETRY_KIND } from "@/api/lib/legal-search/removal-reconciliation-state";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";
import { caseLawSourceRow } from "@/api/tests/helpers/case-law-source-row";
import { publisherRemovalProbe } from "@/api/tests/helpers/publisher-removal-probe";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
const NOW = new Date("2026-10-28T09:00:00.000Z");
const absent = async (): Promise<PublisherRemovalRead> => ({
  type: "absent",
  evidence: "http-410",
});
const present = async (): Promise<PublisherRemovalRead> => ({
  type: "present",
  value: null,
});

if (!databaseUrl || !runPostgresTests) {
  describe.skip("publisher removal evidence and priority (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("publisher removal evidence and priority (postgres)", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const ingestionDb = createIngestionDb(markRlsDatabase(db));
    const scopedDb: ScopedDb = async (run) => await ingestionDb(run);
    const sources: SafeId<"caseLawSource">[] = [];
    cleanUp(async () => {
      for (const sourceId of sources) {
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    });
    const insertDecision = async (
      sourceId: SafeId<"caseLawSource">,
      identity: string,
    ) => {
      const id = createSafeId<"caseLawDecision">();
      await db.insert(caseLawDecisions).values({
        id,
        sourceId,
        sourceDocumentId: identity,
        caseNumber: identity,
        country: "GBR",
        court: "UKSC",
        language: "en",
        fulltext: "Retained judgment text",
        sourceHash: "f".repeat(64),
        sourceObservationOrder: 1n,
        sourceObservedAt: NOW,
      });
      return id;
    };
    const seed = async () => {
      const sourceId = createSafeId<"caseLawSource">();
      sources.push(sourceId);
      await db.insert(caseLawSources).values(
        caseLawSourceRow({
          id: sourceId,
          adapterKey: `evidence-${sourceId}`,
          config: { removalReconciliation: { status: "enabled" } },
        }),
      );
      const id = await insertDecision(sourceId, "uksc/2024/old");
      return { sourceId, id };
    };
    const retryItem = async (sourceId: SafeId<"caseLawSource">) =>
      (
        await db
          .select()
          .from(caseLawRemovalReconciliationItems)
          .where(eq(caseLawRemovalReconciliationItems.sourceId, sourceId))
      ).at(0);
    const queueAbsence = async (sourceId: SafeId<"caseLawSource">) => {
      let elapsed = 0;
      const result = await reconcilePublisherRemovals({
        scopedDb,
        sourceId,
        signal: new AbortController().signal,
        now: () => NOW,
        clock: () => elapsed,
        probe: publisherRemovalProbe(async () => {
          elapsed = REMOVAL_SWEEP_TIME_BUDGET_MS;
          return await absent();
        }),
      });
      expect(result.unwrap()).toMatchObject({
        type: "budget",
        checked: 1,
        retried: 0,
      });
      const queued = await retryItem(sourceId);
      expect(queued).toMatchObject({
        kind: REMOVAL_RETRY_KIND.ERASURE,
        payload: {
          operation: "erase",
          evidence: {
            type: "publisher-absence",
            sourceDocumentId: "uksc/2024/old",
            sourceObservationOrder: "1",
            observedAt: NOW.toISOString(),
            absence: "http-410",
          },
        },
      });
      return queued;
    };
    const removeWithCount =
      (removed: string[]) =>
      async (options: Parameters<typeof removePublisherDecision>[0]) =>
        await removePublisherDecision({
          ...options,
          redact: async (redactOptions) =>
            await redactCaseLawDecisionWithSupplementHolders({
              ...redactOptions,
              redactDecision: async (decisionOptions) =>
                await redactCaseLawDecision({
                  ...decisionOptions,
                  sweepRaw: async () => {
                    removed.push(options.decisionId);
                    return { type: "swept", legacy: "none" };
                  },
                }),
            }),
        });
    const run = async (options: {
      sourceId: SafeId<"caseLawSource">;
      probe: ReturnType<typeof publisherRemovalProbe>;
      remove: typeof removePublisherDecision;
      now?: Date;
    }) =>
      await reconcilePublisherRemovals({
        scopedDb,
        sourceId: options.sourceId,
        signal: new AbortController().signal,
        now: () => options.now ?? NOW,
        probe: options.probe,
        remove: options.remove,
      });
    const expectLive = async (id: SafeId<"caseLawDecision">) => {
      expect(
        await db
          .select({ id: publishedCaseLawDecisions.id })
          .from(publishedCaseLawDecisions)
          .where(eq(publishedCaseLawDecisions.id, id)),
      ).toEqual([{ id }]);
      expect(
        (
          await db
            .select({
              text: caseLawDecisions.fulltext,
              redactedAt: caseLawDecisions.redactedAt,
            })
            .from(caseLawDecisions)
            .where(eq(caseLawDecisions.id, id))
        ).at(0),
      ).toEqual({ text: "Retained judgment text", redactedAt: null });
    };

    for (const change of ["identity", "arrival"] as const) {
      for (const boundary of ["queued", "transaction"] as const) {
        test(`${change} change at the ${boundary} boundary supersedes only the old erasure`, async () => {
          const { sourceId, id } = await seed();
          const queued = await queueAbsence(sourceId);
          const update = async () => {
            if (change === "identity") {
              await db
                .update(caseLawDecisions)
                .set({ sourceDocumentId: "uksc/2024/new" })
                .where(eq(caseLawDecisions.id, id));
            } else {
              // Unchanged ingestion arrivals still advance this watermark.
              await db
                .update(caseLawDecisions)
                .set({
                  sourceObservationOrder: 2n,
                  sourceObservedAt: new Date(NOW.getTime() + 1),
                })
                .where(eq(caseLawDecisions.id, id));
            }
          };
          if (boundary === "queued") {
            await update();
          }
          const erased: string[] = [];
          let probes = 0;
          await run({
            sourceId,
            remove: removeWithCount(erased),
            probe: publisherRemovalProbe(async () => {
              probes++;
              if (boundary === "transaction") {
                await update();
              }
              return await absent();
            }),
          });
          await expectLive(id);
          expect(erased).toEqual([]);
          expect(probes).toBe(boundary === "transaction" ? 1 : 0);
          const superseded = await retryItem(sourceId);
          expect(superseded?.id).not.toBe(queued?.id);
          expect(superseded?.payload).toMatchObject({
            type: "superseded",
            previousItemId: queued?.id,
            reason:
              change === "identity"
                ? REMOVAL_SUPERSEDED_REASON.IDENTITY_CHANGED
                : REMOVAL_SUPERSEDED_REASON.OBSERVATION_CHANGED,
          });
          const identities: string[] = [];
          await run({
            sourceId,
            now: new Date(NOW.getTime() + 60_000),
            remove: removeWithCount(erased),
            probe: publisherRemovalProbe(async (identity) => {
              identities.push(identity);
              return await present();
            }),
          });
          expect(identities).toEqual([
            change === "identity" ? "uksc/2024/new" : "uksc/2024/old",
          ]);
          expect(await retryItem(sourceId)).toBeUndefined();
          expect(erased).toEqual([]);
          await expectLive(id);
        });
      }
    }

    test("publisher restoration supersedes a queued absence without erasing the unchanged row", async () => {
      const { sourceId, id } = await seed();
      const queued = await queueAbsence(sourceId);
      const erased: string[] = [];
      await run({
        sourceId,
        probe: publisherRemovalProbe(present),
        remove: removeWithCount(erased),
      });
      await expectLive(id);
      expect(erased).toEqual([]);
      expect((await retryItem(sourceId))?.payload).toMatchObject({
        type: "superseded",
        reason: REMOVAL_SUPERSEDED_REASON.RESTORED,
        previousItemId: queued?.id,
      });
      await run({
        sourceId,
        now: new Date(NOW.getTime() + 60_000),
        probe: publisherRemovalProbe(present),
        remove: removeWithCount(erased),
      });
      expect(await retryItem(sourceId)).toBeUndefined();
    });

    test("an alias absence cannot widen authorization to a live canonical decision", async () => {
      const { sourceId, id } = await seed();
      await queueAbsence(sourceId);
      const canonicalId = await insertDecision(sourceId, "uksc/2024/canonical");
      await db
        .insert(caseLawDecisionAliases)
        .values({ retiredDecisionId: id, canonicalDecisionId: canonicalId });
      const erased: string[] = [];
      try {
        await run({
          sourceId,
          probe: publisherRemovalProbe(absent),
          remove: removeWithCount(erased),
        });
        expect(erased).toEqual([]);
        await expectLive(canonicalId);
        expect((await retryItem(sourceId))?.payload).toMatchObject({
          type: "superseded",
          reason: REMOVAL_SUPERSEDED_REASON.CANONICAL_CHANGED,
        });
      } finally {
        await db
          .delete(caseLawDecisionAliases)
          .where(eq(caseLawDecisionAliases.retiredDecisionId, id));
      }
    });

    test("due erasure completes before discovery exhausts the run deadline", async () => {
      const { sourceId, id } = await seed();
      await queueAbsence(sourceId);
      const nextId = await insertDecision(sourceId, "uksc/2024/slow-discovery");
      await db
        .update(caseLawSources)
        .set({
          removalCheckpoint: { status: "running", cursor: id, ceiling: nextId },
        })
        .where(eq(caseLawSources.id, sourceId));
      let elapsed = 0;
      const order: string[] = [];
      const erased: string[] = [];
      const remove = removeWithCount(erased);
      const outcomes: unknown[] = [];
      const result = await reconcilePublisherRemovals({
        scopedDb,
        sourceId,
        signal: new AbortController().signal,
        now: () => NOW,
        clock: () => elapsed,
        remove: async (options) => {
          order.push("erase");
          const attempted = await Result.tryPromise({
            try: async () => await remove(options),
            catch: (error: unknown) => error,
          });
          if (attempted.isErr()) {
            outcomes.push(Bun.inspect(attempted.error));
            throw attempted.error;
          }
          const removed = attempted.value;
          outcomes.push(
            removed.isErr() ? Bun.inspect(removed.error) : removed.value,
          );
          return removed;
        },
        probe: publisherRemovalProbe(async (identity) => {
          if (identity.endsWith("slow-discovery")) {
            order.push("discovery");
            elapsed = REMOVAL_SWEEP_TIME_BUDGET_MS;
            return await present();
          }
          order.push("confirmation");
          return await absent();
        }),
      });
      expect(result.unwrap()).toMatchObject({
        type: "budget",
        retried: 1,
        checked: 1,
      });
      expect(outcomes).toEqual([{ type: "removed" }]);
      expect(order).toEqual(["confirmation", "erase", "discovery"]);
      expect(erased).toEqual([id]);
      expect(await retryItem(sourceId)).toBeUndefined();
      expect(
        await db
          .select({ id: publishedCaseLawDecisions.id })
          .from(publishedCaseLawDecisions)
          .where(eq(publishedCaseLawDecisions.id, id)),
      ).toEqual([]);
      await expectLive(nextId);
    });
  });
}
