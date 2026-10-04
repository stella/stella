import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { Temporal } from "@stll/time";

import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  claimCorpusProjectionCleanupSettlementTx,
  claimCorpusProjectionCleanupTx,
  type CorpusProjectionCleanupReissue,
  type CorpusProjectionCleanupSettlementLease,
  CorpusProjectionCleanupSettlementProof,
  recordCorpusProjectionDeleteTx,
  reissueCorpusProjectionCleanupTx,
  settleCorpusProjectionCleanupTx,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/** A manifest generation no other gated suite registers. */
const GENERATION = "case_law_v6";
const DELETE_TASK_CREATED_AT = Temporal.Instant.from("2026-08-25T12:00:00Z");
const LONG_AFTER_THE_TASK = DELETE_TASK_CREATED_AT.add({ hours: 24 * 8 });
const LOCK_WAIT_MS = 200;

const engineWithRemaining = (remaining: number) =>
  ({
    readDeleteSettlements: async ({ tasks }) =>
      Result.ok(
        tasks.map(({ requiredOpstamp }) =>
          Result.ok({
            requiredOpstamp,
            provingSplits: 1,
            excludedSplits: 0,
            laggingSplits: 0,
            minAppliedOpstamp: requiredOpstamp,
            settled: true,
            laggingProvingSplits: [],
            laggingExcludedSplits: [],
          }),
        ),
      ),
    search: async () =>
      Result.ok({ numHits: remaining, hits: [], snippets: [] }),
  }) satisfies Pick<CorpusIndexClient, "readDeleteSettlements" | "search">;

type Fixture = {
  indexId: string;
  sourceId: string;
  entityIds: string[];
  intentIds: SafeId<"corpusIndexProjectionIntent">[];
};

/**
 * Two revisions in `cleanup_pending`, reached through the same transitions the
 * guards admit: reserved, append started, then cleanup.
 */
const seed = async (db: GatedTestDb): Promise<Fixture> => {
  const suffix = Bun.randomUUIDv7().replaceAll("-", "").slice(-12);
  const indexId = `case_law_v6_reissue_${suffix}`;
  const sourceId = Bun.randomUUIDv7();
  const entityIds = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
  const intentIds = entityIds.map(() =>
    toSafeId<"corpusIndexProjectionIntent">(Bun.randomUUIDv7()),
  );
  const fingerprint = "e".repeat(64);
  const seededAt = new Date("2026-08-25T00:00:00.000Z");
  // The suite owns the generation for its run and removes it afterwards.
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: GENERATION,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v6,
    ),
    status: "building",
  });
  await db.insert(caseLawSources).values({
    id: toSafeId<"caseLawSource">(sourceId),
    adapterKey: `projection-reissue-${suffix}`,
    name: "Projection reissue",
  });
  await db.insert(caseLawDecisions).values(
    entityIds.map((id, index) => ({
      id: toSafeId<"caseLawDecision">(id),
      sourceId: toSafeId<"caseLawSource">(sourceId),
      caseNumber: `projection-reissue-${suffix}-${index}`,
      court: "Test court",
      country: "CZE",
      language: "cs",
      contentHash: "c".repeat(64),
      projectionEpoch: 1n,
    })),
  );
  await db.insert(corpusIndexProjectionStates).values(
    entityIds.map((entityId) => ({
      family: "case_law" as const,
      generation: GENERATION,
      entityId,
      desiredAction: "upsert" as const,
      desiredEpoch: 1n,
      desiredFingerprint: fingerprint,
      desiredIndexId: indexId,
      updatedAt: seededAt,
    })),
  );
  await db.insert(corpusIndexProjectionIntents).values(
    entityIds.map((entityId, index) => ({
      id: intentIds[index] ?? panic("intent id"),
      family: "case_law" as const,
      generation: GENERATION,
      entityId,
      epoch: 1n,
      fingerprint,
      indexId,
      status: "reserved" as const,
      leaseToken: Bun.randomUUIDv7(),
      leaseExpiresAt: seededAt,
    })),
  );
  await db
    .update(corpusIndexProjectionIntents)
    .set({ status: "append_started", appendStartedAt: seededAt })
    .where(inArray(corpusIndexProjectionIntents.id, intentIds));
  await db
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_pending",
      leaseToken: null,
      leaseExpiresAt: null,
      appendPublishBarrierAt: seededAt,
      cleanupNotBefore: seededAt,
    })
    .where(inArray(corpusIndexProjectionIntents.id, intentIds));
  return { indexId, sourceId, entityIds, intentIds };
};

const scopeOf = ({ indexId }: Fixture) =>
  ({ family: "case_law", generation: GENERATION, indexId }) as const;

const commitDelete = async (
  db: GatedTestDb,
  fixture: Fixture,
  deleteOpstamp: number,
): Promise<void> => {
  const leaseToken = Bun.randomUUIDv7();
  const leases = await db.transaction(
    async (tx) =>
      await claimCorpusProjectionCleanupTx(tx, {
        ...scopeOf(fixture),
        limit: 10,
        leaseMs: 60_000,
        newLeaseToken: () => leaseToken,
      }),
  );
  expect(leases).toHaveLength(fixture.intentIds.length);
  await db.transaction(
    async (tx) =>
      await recordCorpusProjectionDeleteTx(tx, {
        intentIds: fixture.intentIds,
        indexId: fixture.indexId,
        leaseToken,
        deleteOpstamp,
        deleteTaskCreatedAt: DELETE_TASK_CREATED_AT,
      }),
  );
};

const claimSettlement = async (
  db: GatedTestDb,
  fixture: Fixture,
): Promise<CorpusProjectionCleanupSettlementLease[]> =>
  await db.transaction(
    async (tx) =>
      await claimCorpusProjectionCleanupSettlementTx(tx, {
        ...scopeOf(fixture),
        limit: 10,
        taskLimit: 1,
        leaseMs: 60_000,
      }),
  );

const verify = async (
  lease: CorpusProjectionCleanupSettlementLease,
  remaining: number,
) => {
  const verdict = (
    await CorpusProjectionCleanupSettlementProof.verifyAll({
      client: engineWithRemaining(remaining),
      indexId: lease.indexId,
      leases: [lease],
      testNow: LONG_AFTER_THE_TASK,
    })
  ).at(0);
  if (verdict === undefined || verdict.result.isErr()) {
    return panic("Expected one settlement verdict");
  }
  return verdict.result.value;
};

const survivorOf = async (
  lease: CorpusProjectionCleanupSettlementLease,
): Promise<CorpusProjectionCleanupReissue> => {
  const result = await verify(lease, 2);
  if (result.status !== "pending" || result.reason !== "survivor") {
    return panic("Expected a survivor verdict");
  }
  return result.reissue;
};

/** Drives the revisions to `settled` so the generation's history can go. */
const cleanUp = async (db: GatedTestDb, fixture: Fixture): Promise<void> => {
  const pending = await db
    .select({ id: corpusIndexProjectionIntents.id })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        inArray(corpusIndexProjectionIntents.id, fixture.intentIds),
        eq(corpusIndexProjectionIntents.status, "cleanup_pending"),
      ),
    );
  if (pending.length === fixture.intentIds.length) {
    await commitDelete(db, fixture, 99);
  }
  for (const lease of await claimSettlement(db, fixture)) {
    const result = await verify(lease, 0);
    if (result.status === "verified") {
      await db.transaction(
        async (tx) =>
          await settleCorpusProjectionCleanupTx(tx, { proof: result.proof }),
      );
    }
  }
  const generation = and(
    eq(corpusIndexGenerations.family, "case_law"),
    eq(corpusIndexGenerations.generation, GENERATION),
  );
  // Projection history is deletable only under a retired generation.
  await db
    .update(corpusIndexGenerations)
    .set({ status: "retired" })
    .where(generation);
  await db
    .delete(corpusIndexProjectionIntents)
    .where(inArray(corpusIndexProjectionIntents.id, fixture.intentIds));
  await db
    .delete(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.generation, GENERATION),
        inArray(corpusIndexProjectionStates.entityId, fixture.entityIds),
      ),
    );
  await db.delete(caseLawDecisions).where(
    inArray(
      caseLawDecisions.id,
      fixture.entityIds.map((id) => toSafeId<"caseLawDecision">(id)),
    ),
  );
  await db
    .delete(caseLawSources)
    .where(eq(caseLawSources.id, toSafeId<"caseLawSource">(fixture.sourceId)));
  await db.delete(corpusIndexGenerations).where(generation);
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("corpus projection cleanup reissue (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("corpus projection cleanup reissue (postgres)", () => {
    test("two turns reissuing one survivor at once move it once", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: firstDb } = openClient();
        const { db: secondDb } = openClient();
        const fixture = await seed(firstDb);
        try {
          await commitDelete(firstDb, fixture, 42);
          const lease =
            (await claimSettlement(firstDb, fixture)).at(0) ??
            panic("Expected a settlement lease");
          const evidence = await survivorOf(lease);

          // The first turn holds the revisions locked mid-transaction while
          // the second asks for the same transition.
          const firstHolds = Promise.withResolvers<undefined>();
          const releaseFirst = Promise.withResolvers<undefined>();
          const first = firstDb.transaction(async (tx) => {
            const result = await reissueCorpusProjectionCleanupTx(tx, {
              reissue: evidence,
            });
            firstHolds.resolve(undefined);
            await releaseFirst.promise;
            return result;
          });
          await firstHolds.promise;
          const second = secondDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
            return await reissueCorpusProjectionCleanupTx(tx, {
              reissue: evidence,
            });
          });
          const secondFinishedWhileHeld = await Promise.race([
            second.then(() => true),
            Bun.sleep(LOCK_WAIT_MS).then(() => false),
          ]);
          expect(secondFinishedWhileHeld).toBe(false);
          releaseFirst.resolve(undefined);

          const sorted = fixture.intentIds.toSorted();
          const firstResult = await first;
          const secondResult = await second;
          expect(firstResult.reissuedIntentIds.toSorted()).toEqual(sorted);
          expect(firstResult.stalledIntentIds).toEqual([]);
          expect(firstResult.unleasedIntentIds).toEqual([]);
          expect(secondResult.reissuedIntentIds).toEqual([]);
          expect(secondResult.stalledIntentIds).toEqual([]);
          expect(secondResult.unleasedIntentIds.toSorted()).toEqual(sorted);
          expect(
            await firstDb
              .select({
                status: corpusIndexProjectionIntents.status,
                deleteReissues: corpusIndexProjectionIntents.deleteReissues,
              })
              .from(corpusIndexProjectionIntents)
              .where(
                inArray(corpusIndexProjectionIntents.id, fixture.intentIds),
              ),
          ).toEqual(
            fixture.intentIds.map(() => ({
              status: "cleanup_pending",
              deleteReissues: 1,
            })),
          );
        } finally {
          await cleanUp(firstDb, fixture);
        }
      });
    });

    test("a settlement claim racing a reissue never leases the reissued revisions", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: reissueDb } = openClient();
        const { db: claimDb } = openClient();
        const fixture = await seed(reissueDb);
        try {
          await commitDelete(reissueDb, fixture, 42);
          const lease =
            (await claimSettlement(reissueDb, fixture)).at(0) ??
            panic("Expected a settlement lease");
          // The lease ran out: a racing claim may take the revisions over.
          await reissueDb
            .update(corpusIndexProjectionIntents)
            .set({ leaseExpiresAt: new Date("2026-08-25T12:00:00.000Z") })
            .where(inArray(corpusIndexProjectionIntents.id, fixture.intentIds));
          const evidence = await survivorOf(lease);

          const reissueHolds = Promise.withResolvers<undefined>();
          const releaseReissue = Promise.withResolvers<undefined>();
          const reissue = reissueDb.transaction(async (tx) => {
            const result = await reissueCorpusProjectionCleanupTx(tx, {
              reissue: evidence,
            });
            reissueHolds.resolve(undefined);
            await releaseReissue.promise;
            return result;
          });
          await reissueHolds.promise;
          const claim = claimSettlement(claimDb, fixture);
          await Bun.sleep(LOCK_WAIT_MS);
          releaseReissue.resolve(undefined);

          expect((await reissue).reissuedIntentIds.toSorted()).toEqual(
            fixture.intentIds.toSorted(),
          );
          // Locked rows are skipped and committed ones are cleanup work, so the
          // claim leases nothing either way.
          expect(await claim).toEqual([]);
        } finally {
          await cleanUp(reissueDb, fixture);
        }
      });
    });
  });
}
