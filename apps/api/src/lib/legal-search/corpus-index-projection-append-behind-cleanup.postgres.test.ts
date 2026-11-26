/**
 * The interleavings of an append beside an older revision's delete, on
 * PostgreSQL with two connections, so each race is a real one: two reservers
 * of the same entities, a reservation against the old revision's
 * settlement (in both orders), and the new revision's proof against an
 * erasure. Every one ends in the state one transaction after the other would
 * leave, with one append-producing revision per entity and epoch, and none
 * waits on a lock it cannot be granted.
 */
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { settledWithin, waitFor } from "@stll/test-kit";
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
  CorpusProjectionCleanupSettlementProof,
  recordCorpusProjectionDeleteTx,
  settleCorpusProjectionCleanupTx,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import {
  readDeferredAppendStatesTx,
  wakeDeferredAppendStatesBatchTx,
} from "@/api/lib/legal-search/corpus-index-projection-deferred-wake";
import { proveCorpusProjectionRevisionsPresent } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { advanceCorpusProjectionErasuresTx } from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import {
  type CorpusProjectionIntentLease,
  proveAcceptedCorpusProjectionAppendsTx,
  recordAcceptedCorpusProjectionAppendsTx,
  reserveCorpusProjectionIntentsTx,
  startCorpusProjectionAppendTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/** A generation whose hits carry their revision; the suite removes it after. */
const GENERATION = "case_law_v12";
const MANIFEST = CORPUS_INDEX_MANIFESTS.case_law_v12;
const DELETE_TASK_CREATED_AT = Temporal.Instant.from("2026-08-25T12:00:00Z");
const LONG_AFTER_THE_TASK = DELETE_TASK_CREATED_AT.add({ hours: 24 * 8 });
const SEEDED_AT = new Date("2026-08-25T00:00:00.000Z");
const FINGERPRINT = "e".repeat(64);
/** Bound on a statement that must not wait on another session's locks. */
const UNBLOCKED_WITHIN_MS = 5000;

type ProjectionIntentId = SafeId<"corpusIndexProjectionIntent">;

type Fixture = {
  indexId: string;
  sourceId: string;
  entityIds: string[];
  /** Each entity's first revision, its delete committed and not settled. */
  oldIds: ProjectionIntentId[];
};

const settledEngine = {
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
  search: async () => Result.ok({ numHits: 0, hits: [], snippets: [] }),
} satisfies Pick<CorpusIndexClient, "readDeleteSettlements" | "search">;

/**
 * `count` decisions whose first attempt was lost and whose delete is
 * committed: reached through the transitions the guards admit (reserved,
 * started, cleanup, a claimed and recorded delete).
 */
const seed = async (db: GatedTestDb, count: number): Promise<Fixture> => {
  const suffix = Bun.randomUUIDv7().replaceAll("-", "").slice(-12);
  const indexId = `case_law_v12_overlap_${suffix}`;
  const sourceId = Bun.randomUUIDv7();
  const entityIds = Array.from({ length: count }, () => Bun.randomUUIDv7());
  const oldIds = entityIds.map(() =>
    toSafeId<"corpusIndexProjectionIntent">(Bun.randomUUIDv7()),
  );
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: GENERATION,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(MANIFEST),
    status: "building",
  });
  await db.insert(caseLawSources).values({
    id: toSafeId<"caseLawSource">(sourceId),
    adapterKey: `projection-overlap-${suffix}`,
    name: "Projection overlap",
  });
  await db.transaction(async (tx) => {
    await tx.insert(caseLawDecisions).values(
      entityIds.map((id, index) => ({
        id: toSafeId<"caseLawDecision">(id),
        sourceId: toSafeId<"caseLawSource">(sourceId),
        caseNumber: `projection-overlap-${suffix}-${index}`,
        court: "Test court",
        country: "CZE",
        language: "cs",
        contentHash: "c".repeat(64),
        projectionEpoch: 1n,
      })),
    );
    await tx.insert(corpusIndexProjectionStates).values(
      entityIds.map((entityId) => ({
        family: "case_law" as const,
        generation: GENERATION,
        entityId,
        desiredAction: "upsert" as const,
        desiredEpoch: 1n,
        desiredFingerprint: FINGERPRINT,
        desiredIndexId: indexId,
        updatedAt: SEEDED_AT,
      })),
    );
  });
  await db.insert(corpusIndexProjectionIntents).values(
    entityIds.map((entityId, index) => ({
      id: oldIds[index] ?? panic("intent id"),
      family: "case_law" as const,
      generation: GENERATION,
      entityId,
      epoch: 1n,
      fingerprint: FINGERPRINT,
      indexId,
      status: "reserved" as const,
      leaseToken: Bun.randomUUIDv7(),
      leaseExpiresAt: SEEDED_AT,
    })),
  );
  await db
    .update(corpusIndexProjectionIntents)
    .set({ status: "append_started", appendStartedAt: SEEDED_AT })
    .where(inArray(corpusIndexProjectionIntents.id, oldIds));
  await db
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_pending",
      leaseToken: null,
      leaseExpiresAt: null,
      appendPublishBarrierAt: SEEDED_AT,
      cleanupNotBefore: SEEDED_AT,
    })
    .where(inArray(corpusIndexProjectionIntents.id, oldIds));
  const leaseToken = Bun.randomUUIDv7();
  const claimed = await db.transaction(
    async (tx) =>
      await claimCorpusProjectionCleanupTx(tx, {
        family: "case_law",
        generation: GENERATION,
        indexId,
        limit: count,
        leaseMs: 60_000,
        newLeaseToken: () => leaseToken,
      }),
  );
  expect(claimed.leases).toHaveLength(count);
  await db.transaction(
    async (tx) =>
      await recordCorpusProjectionDeleteTx(tx, {
        intentIds: oldIds,
        indexId,
        leaseToken,
        deleteOpstamp: 42,
        deleteTaskCreatedAt: DELETE_TASK_CREATED_AT,
      }),
  );
  return { indexId, sourceId, entityIds, oldIds };
};

const reserve = (
  tx: Parameters<Parameters<GatedTestDb["transaction"]>[0]>[0],
  fixture: Fixture,
) =>
  reserveCorpusProjectionIntentsTx(tx, {
    family: "case_law",
    generation: GENERATION,
    scope: { type: "subjects", entityIds: fixture.entityIds },
    limit: fixture.entityIds.length,
    leaseMs: 60_000,
  });

/** Settle the old revisions' delete in `tx`, its proof read beforehand. */
const readSettlementProof = async (db: GatedTestDb, fixture: Fixture) => {
  const lease =
    (
      await db.transaction(
        async (tx) =>
          await claimCorpusProjectionCleanupSettlementTx(tx, {
            family: "case_law",
            generation: GENERATION,
            indexId: fixture.indexId,
            limit: fixture.oldIds.length,
            taskLimit: 1,
            leaseMs: 60_000,
          }),
      )
    ).at(0) ?? panic("Expected a settlement lease");
  const verdict = (
    await CorpusProjectionCleanupSettlementProof.verifyAll({
      client: settledEngine,
      indexId: fixture.indexId,
      leases: [lease],
      testNow: LONG_AFTER_THE_TASK,
    })
  ).at(0);
  if (
    verdict === undefined ||
    verdict.result.isErr() ||
    verdict.result.value.status !== "verified"
  ) {
    return panic("Expected the old delete to be proven settled");
  }
  return verdict.result.value.proof;
};

const intentsOf = async (db: GatedTestDb, fixture: Fixture) =>
  await db
    .select({
      id: corpusIndexProjectionIntents.id,
      entityId: corpusIndexProjectionIntents.entityId,
      epoch: corpusIndexProjectionIntents.epoch,
      status: corpusIndexProjectionIntents.status,
    })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.generation, GENERATION),
        inArray(corpusIndexProjectionIntents.entityId, fixture.entityIds),
      ),
    );

type SuiteTransaction = Parameters<
  Parameters<GatedTestDb["transaction"]>[0]
>[0];

/** The server process of the session `tx` runs on. */
const backendPid = async (tx: SuiteTransaction): Promise<number> => {
  const rows = await tx.execute<{ pid: number }>(
    sql`SELECT pg_backend_pid() AS pid`,
  );
  return rows.at(0)?.pid ?? panic("No backend pid");
};

/**
 * A transaction that runs `work`, then holds its locks until released. `pid`
 * names its session, so an observer can tell what waits on it.
 */
const holding = <T>(
  db: GatedTestDb,
  work: (tx: SuiteTransaction) => Promise<T>,
) => {
  const held = Promise.withResolvers<T>();
  const pid = Promise.withResolvers<number>();
  const release = Promise.withResolvers<undefined>();
  const done = db.transaction(async (tx) => {
    pid.resolve(await backendPid(tx));
    const value = await work(tx);
    held.resolve(value);
    await release.promise;
    return value;
  });
  done.catch((error: unknown) => {
    held.reject(error);
    pid.reject(error);
  });
  return {
    held: held.promise,
    pid: pid.promise,
    release: () => release.resolve(undefined),
    done,
  };
};

/** `work` in a transaction of `db`, reporting its session's pid first. */
const reporting = <T>(
  db: GatedTestDb,
  work: (tx: SuiteTransaction) => Promise<T>,
) => {
  const pid = Promise.withResolvers<number>();
  const done = db.transaction(async (tx) => {
    pid.resolve(await backendPid(tx));
    return await work(tx);
  });
  done.catch((error: unknown) => pid.reject(error));
  return { pid: pid.promise, done };
};

/** A statement that must finish while another session still holds its rows. */
const unblocked = async <T>(pending: Promise<T>, description: string) =>
  await settledWithin(pending, {
    description,
    timeoutMs: UNBLOCKED_WITHIN_MS,
  });

/**
 * Resolves once session `waiter` waits on a lock session `holder` holds:
 * PostgreSQL's own account of who blocks whom, not any waiter.
 */
const waitsOn = async (
  observer: GatedTestDb,
  { waiter, holder }: { waiter: number; holder: number },
) =>
  await waitFor(
    async () => {
      const rows = await observer.execute<{ blocked: boolean }>(sql`
        SELECT ${holder}::int = ANY(pg_blocking_pids(${waiter}::int)) AS blocked`);
      return rows.at(0)?.blocked === true ? true : undefined;
    },
    {
      description: `session ${String(waiter)} to wait on session ${String(holder)}`,
      timeoutMs: 10_000,
    },
  );

const cleanUp = async (db: GatedTestDb, fixture: Fixture): Promise<void> => {
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
    .where(
      and(
        eq(corpusIndexProjectionIntents.generation, GENERATION),
        inArray(corpusIndexProjectionIntents.entityId, fixture.entityIds),
      ),
    );
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

const appendProducing = new Set([
  "reserved",
  "append_started",
  "append_committed",
  "applied",
]);

if (!databaseUrl || !runPostgresTests) {
  describe.skip("an append beside an older revision's delete (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("an append beside an older revision's delete (postgres)", () => {
    test("two reservers racing for the same entities reserve each once", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: firstDb } = openClient();
        const { db: secondDb } = openClient();
        const fixture = await seed(firstDb, 4);
        try {
          const first = holding(
            firstDb,
            async (tx) => await reserve(tx, fixture),
          );
          expect(await first.held).toHaveLength(4);
          // The second reserver neither waits on the first one's rows nor
          // takes them: they are skipped, not queued for.
          const second = secondDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
            return await reserve(tx, fixture);
          });
          expect(
            await unblocked(second, "the second reserver to skip held rows"),
          ).toEqual([]);
          first.release();
          await first.done;

          // Unsynchronised, as many walkers as entities: still one each.
          const racers = await Promise.all(
            [firstDb, secondDb, firstDb, secondDb].map(
              async (db) =>
                await db.transaction(async (tx) => await reserve(tx, fixture)),
            ),
          );
          expect(racers.flat()).toEqual([]);
          const intents = await intentsOf(firstDb, fixture);
          for (const entityId of fixture.entityIds) {
            const producing = intents.filter(
              (intent) =>
                intent.entityId === entityId &&
                appendProducing.has(intent.status),
            );
            expect(producing).toHaveLength(1);
            expect(producing[0]?.epoch).toBe(1n);
          }
          expect(
            intents
              .filter(({ status }) => status === "cleanup_committed")
              .map(({ id }) => id)
              .toSorted(),
          ).toEqual(fixture.oldIds.toSorted());
        } finally {
          await cleanUp(firstDb, fixture);
        }
      });
    });

    test("a reservation and the old revision's settlement interleave in either order", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: firstDb } = openClient();
        const { db: secondDb } = openClient();
        const { db: observerDb } = openClient();
        // Settlement first: it holds the states, so the walk skips them.
        const settleFirst = await seed(firstDb, 2);
        try {
          const proof = await readSettlementProof(firstDb, settleFirst);
          const settling = holding(firstDb, async (tx) =>
            settleCorpusProjectionCleanupTx(tx, { proof }),
          );
          expect(await settling.held).toBe(2);
          const reserving = secondDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
            return await reserve(tx, settleFirst);
          });
          expect(
            await unblocked(
              reserving,
              "the walk to skip states settlement holds",
            ),
          ).toEqual([]);
          settling.release();
          await settling.done;
          const after = await secondDb.transaction(
            async (tx) => await reserve(tx, settleFirst),
          );
          expect(after).toHaveLength(2);
        } finally {
          await cleanUp(firstDb, settleFirst);
        }

        // Reservation first: settlement waits for its states, then settles
        // the old revisions and leaves the new ones as they are.
        const reserveFirst = await seed(firstDb, 2);
        try {
          const proof = await readSettlementProof(firstDb, reserveFirst);
          const reservingFirst = holding(
            firstDb,
            async (tx) => await reserve(tx, reserveFirst),
          );
          const leases = await reservingFirst.held;
          expect(leases).toHaveLength(2);
          const settlingAfter = reporting(secondDb, async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
            return await settleCorpusProjectionCleanupTx(tx, { proof });
          });
          // Settlement waits on the reservation's session, for the states
          // it holds, and on nothing else.
          await waitsOn(observerDb, {
            waiter: await settlingAfter.pid,
            holder: await reservingFirst.pid,
          });
          reservingFirst.release();
          await reservingFirst.done;
          expect(await settlingAfter.done).toBe(2);
          const intents = await intentsOf(firstDb, reserveFirst);
          expect(
            intents
              .filter(({ status }) => status === "settled")
              .map(({ id }) => id)
              .toSorted(),
          ).toEqual(reserveFirst.oldIds.toSorted());
          expect(
            intents
              .filter(({ status }) => status === "reserved")
              .map(({ id }) => id)
              .toSorted(),
          ).toEqual(leases.map(({ intentId }) => intentId).toSorted());
        } finally {
          await cleanUp(firstDb, reserveFirst);
        }
      });
    });

    test("the deferred-state wake passes over a state a writer holds, and a rerun takes it", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: firstDb } = openClient();
        const { db: secondDb } = openClient();
        const fixture = await seed(firstDb, 3);
        try {
          // As an earlier release left them: queued at a settlement bound.
          await firstDb
            .update(corpusIndexProjectionStates)
            .set({ updatedAt: sql`now() + interval '7 days'` })
            .where(
              and(
                eq(corpusIndexProjectionStates.generation, GENERATION),
                inArray(
                  corpusIndexProjectionStates.entityId,
                  fixture.entityIds,
                ),
              ),
            );
          const target = {
            family: "case_law" as const,
            generation: GENERATION,
            retrieval: {
              type: "stored" as const,
              field: "projection_revision" as const,
            },
          };
          const owed = async () =>
            await secondDb.transaction(
              async (tx) => await readDeferredAppendStatesTx(tx, target),
            );
          expect((await owed()).count).toBe(3);
          const [heldEntity] = fixture.entityIds;
          const writer = holding(firstDb, async (tx) =>
            tx.execute(sql`
              SELECT entity_id
              FROM corpus_index_projection_states
              WHERE generation = ${GENERATION} AND entity_id = ${heldEntity ?? ""}
              FOR UPDATE`),
          );
          await writer.held;
          const woken = await unblocked(
            secondDb.transaction(
              async (tx) =>
                await wakeDeferredAppendStatesBatchTx(tx, target, 10),
            ),
            "the wake to pass over the held state",
          );
          expect(woken).toBe(2);
          expect((await owed()).count).toBe(1);
          writer.release();
          await writer.done;
          expect(
            await secondDb.transaction(
              async (tx) =>
                await wakeDeferredAppendStatesBatchTx(tx, target, 10),
            ),
          ).toBe(1);
          expect((await owed()).count).toBe(0);
        } finally {
          await cleanUp(firstDb, fixture);
        }
      });
    });

    test("the new revision's proof and an erasure race to one outcome", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: firstDb } = openClient();
        const { db: secondDb } = openClient();
        const fixture = await seed(firstDb, 1);
        try {
          const lease: CorpusProjectionIntentLease =
            (
              await firstDb.transaction(
                async (tx) => await reserve(tx, fixture),
              )
            ).at(0) ?? panic("Expected the retry to be reserved");
          expect(
            await firstDb.transaction(
              async (tx) =>
                await startCorpusProjectionAppendTx(tx, {
                  intentId: lease.intentId,
                  leaseToken: lease.leaseToken,
                }),
            ),
          ).toBe("started");
          expect(
            (
              await firstDb.transaction(
                async (tx) =>
                  await recordAcceptedCorpusProjectionAppendsTx(tx, {
                    accepted: [
                      {
                        intentId: lease.intentId,
                        leaseToken: lease.leaseToken,
                        documentCount: 1,
                      },
                    ],
                    delivery: { type: "ingest_api" },
                  }),
              )
            ).at(0)?.status,
          ).toBe("accepted");
          // The decision is erased while its new revision awaits proof.
          const [entityId] = fixture.entityIds;
          await firstDb.transaction(async (tx) => {
            await tx
              .update(caseLawDecisions)
              .set({ projectionEpoch: 2n })
              .where(
                eq(
                  caseLawDecisions.id,
                  toSafeId<"caseLawDecision">(entityId ?? ""),
                ),
              );
            await tx
              .update(corpusIndexProjectionStates)
              .set({
                desiredAction: "erase",
                desiredEpoch: 2n,
                desiredFingerprint: null,
                desiredIndexId: null,
              })
              .where(
                and(
                  eq(corpusIndexProjectionStates.generation, GENERATION),
                  eq(corpusIndexProjectionStates.entityId, entityId ?? ""),
                ),
              );
          });
          const census = await proveCorpusProjectionRevisionsPresent({
            client: {
              aggregate: async () =>
                Result.ok({
                  projection_revisions: {
                    buckets: [{ key: lease.intentId, doc_count: 1 }],
                    doc_count_error_upper_bound: 0,
                    sum_other_doc_count: 0,
                  },
                }),
            },
            indexId: fixture.indexId,
            expected: [{ revision: lease.intentId, documentCount: 1 }],
          });
          if (census.isErr()) {
            return panic("Expected a census");
          }
          const proving = holding(firstDb, async (tx) =>
            proveAcceptedCorpusProjectionAppendsTx(tx, {
              indexId: fixture.indexId,
              census: census.value,
              timing: {
                type: "request_waited",
                failureMessage: "projection append is not fully searchable",
              },
            }),
          );
          await proving.held;
          const erase = async () =>
            await secondDb.transaction(async (tx) => {
              await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
              return await advanceCorpusProjectionErasuresTx(tx, {
                family: "case_law",
                generation: GENERATION,
                scope: { type: "subjects", entityIds: fixture.entityIds },
                limit: 1,
              });
            });
          // The erasure claim never waits: it passes over the state the proof
          // holds, and claims nothing while the proof is open.
          const whileHeld = await unblocked(
            erase(),
            "the erasure claim to pass over the held state",
          );
          expect(whileHeld).toMatchObject({
            claimedCount: 0,
            scheduledRevisions: [],
            appliedEntityIds: [],
          });
          proving.release();
          // The proof found the desired state moved: the new revision goes to
          // cleanup and the state never names it.
          expect(await proving.done).toEqual([
            expect.objectContaining({ intentId: lease.intentId }),
          ]);
          const erased = await erase();
          // Neither copy is served, and the erasure waits for both deletes.
          expect(erased.claimedCount).toBe(1);
          expect(erased.scheduledRevisions).toEqual([]);
          expect(erased.appliedEntityIds).toEqual([]);
          const intents = await intentsOf(firstDb, fixture);
          expect(intents.find(({ id }) => id === lease.intentId)?.status).toBe(
            "cleanup_pending",
          );
          expect(
            intents.find(({ id }) => id === fixture.oldIds[0])?.status,
          ).toBe("cleanup_committed");
          const [state] = await firstDb
            .select({
              appliedAction: corpusIndexProjectionStates.appliedAction,
              appliedRevision: corpusIndexProjectionStates.appliedRevision,
            })
            .from(corpusIndexProjectionStates)
            .where(
              and(
                eq(corpusIndexProjectionStates.generation, GENERATION),
                eq(corpusIndexProjectionStates.entityId, entityId ?? ""),
              ),
            );
          expect(state).toEqual({ appliedAction: null, appliedRevision: null });
        } finally {
          await cleanUp(firstDb, fixture);
        }
      });
    });
  });
}
