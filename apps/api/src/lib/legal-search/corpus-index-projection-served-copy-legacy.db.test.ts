import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql, TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import { lockPendingCorpusProjectionCleanups } from "@/api/lib/db/aggregate-lock";
import {
  advanceCorpusProjectionDesiredStateTx,
  reconcileCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { advanceCorpusProjectionErasuresTx } from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import { corpusIndexProjectionRevisionIsRestorable } from "@/api/lib/legal-search/corpus-index-projection-sql";
import {
  corpusProjectionLegacyFixture,
  GENERATION,
} from "@/api/tests/helpers/corpus-projection-legacy-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * Rows an earlier release writes, and what this release does with them, with
 * the earlier release's statements replayed against the guards before and
 * after this release's migration. The one-off pass over copies it left served
 * is tested in `corpus-index-projection-legacy-retire.db.test.ts`.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const {
  uuid,
  fingerprint,
  installProjectionDdl,
  installServedCopyGuard,
  run,
  servedEntity,
  changeDesired,
  thisReleaseChanges,
  previousPrepare,
  previousClaim,
  previousSweepCleanup,
  previousErasureFence,
  previousRepair,
  previousReleaseLifecycle,
  seedGeneration,
  claim,
  intentOf,
  stateOf,
} = corpusProjectionLegacyFixture(() => db);

beforeEach(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await seedGeneration();
});

afterEach(async () => {
  await client.close();
});

describe("the migration and the previous release", () => {
  test("every write the previous release makes passes the guards before and after the migration", async () => {
    await installProjectionDdl(false);
    await previousReleaseLifecycle();
    await installServedCopyGuard();
    await previousReleaseLifecycle();
    const statuses = await db.execute<{ status: string; count: number }>(sql`
      SELECT status, count(*)::int AS count
      FROM corpus_index_projection_intents
      GROUP BY status ORDER BY status
    `);
    // Both lifecycles ran to the same end.
    expect(statuses.rows.every(({ count }) => count % 2 === 0)).toBe(true);
  });
});

describe("cleanup of revisions the previous release left served", () => {
  beforeEach(async () => {
    await installProjectionDdl(true);
  });

  test("a prepared revision no delete reached is restored, not claimed", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await previousPrepare(entityId, revision);

    const result = await claim();
    expect(result.leases).toEqual([]);
    expect(result.restoredIntentIds).toEqual([
      toSafeId<"corpusIndexProjectionIntent">(revision),
    ]);
    expect(await intentOf(revision)).toEqual({
      status: "applied",
      cleanupAttempts: 0,
      cleanupNotBefore: null,
      lastError: null,
    });
    expect(await stateOf(entityId)).toMatchObject({
      desiredAction: "upsert",
      appliedAction: "upsert",
      appliedRevision: revision,
    });
  });

  test("a prepared revision whose state predates the desired-change stamp is restored", async () => {
    const { entityId, revision } = await servedEntity({
      desiredAtRecorded: false,
    });
    await changeDesired(
      entityId,
      2,
      { action: "upsert", fingerprint: fingerprint(1) },
      { desiredAtRecorded: false },
    );
    await previousPrepare(entityId, revision);

    const result = await claim();
    expect(result.leases).toEqual([]);
    expect(result.restoredIntentIds).toEqual([
      toSafeId<"corpusIndexProjectionIntent">(revision),
    ]);
    expect(await intentOf(revision)).toMatchObject({ status: "applied" });
  });

  test("a revision prepared after an erasure and its undo is claimed, never restored", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, { action: "erase" });
    await changeDesired(entityId, 3, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await previousPrepare(entityId, revision);

    const result = await claim();
    expect(result.restoredIntentIds).toEqual([]);
    expect(result.claimed).toEqual({
      unserved: 0,
      served_after_delete: 0,
      served_unproven: 1,
    });
    expect(await intentOf(revision)).toMatchObject({
      status: "cleanup_started",
      cleanupAttempts: 1,
    });
  });

  test("a revision prepared two epochs behind with unchanged content is restored", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(0),
    });
    await changeDesired(entityId, 3, {
      action: "upsert",
      fingerprint: fingerprint(0),
    });
    await previousPrepare(entityId, revision);

    const result = await claim();
    expect(result.leases).toEqual([]);
    expect(result.restoredIntentIds).toEqual([
      toSafeId<"corpusIndexProjectionIntent">(revision),
    ]);
  });

  test("two content changes by this release keep serving the copy", async () => {
    const { entityId, revision } = await servedEntity();
    await thisReleaseChanges(entityId, fingerprint(3));
    await thisReleaseChanges(entityId, fingerprint(4));
    expect(await stateOf(entityId)).toEqual({
      desiredAction: "upsert",
      appliedAction: "upsert",
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(revision),
    });
    expect(await intentOf(revision)).toMatchObject({ status: "applied" });
  });

  test("a restored copy stays served through this release's next reconciliation", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await previousPrepare(entityId, revision);
    expect((await claim()).restoredIntentIds).toHaveLength(1);

    // The canonical row projects to another fingerprint than the state holds,
    // so reconciliation moves every generation to a newer epoch.
    await db.transaction(
      async (tx) =>
        await reconcileCorpusProjectionDesiredStateTx(
          asTestRaw<Transaction>(tx),
          {
            family: "legislation",
            entityId: toSafeId<"legislationDocument">(entityId),
          },
        ),
    );
    expect(await stateOf(entityId)).toEqual({
      desiredAction: "upsert",
      appliedAction: "upsert",
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(revision),
    });
    expect(await intentOf(revision)).toMatchObject({ status: "applied" });
  });

  test("a prepared revision whose desired value changed again is claimed as unproven", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await previousPrepare(entityId, revision);
    await changeDesired(entityId, 3, { action: "erase" });
    await changeDesired(entityId, 4, {
      action: "upsert",
      fingerprint: fingerprint(2),
    });

    const result = await claim();
    expect(result.restoredIntentIds).toEqual([]);
    expect(result.claimed).toEqual({
      unserved: 0,
      served_after_delete: 0,
      served_unproven: 1,
    });
    expect(await intentOf(revision)).toMatchObject({
      status: "cleanup_started",
      cleanupAttempts: 1,
    });
  });

  test("a served revision a delete may have reached is claimed again, never held", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await previousPrepare(entityId, revision);
    await previousClaim(revision);
    await previousSweepCleanup(revision);

    const result = await claim();
    expect(result.claimed).toEqual({
      unserved: 0,
      served_after_delete: 1,
      served_unproven: 0,
    });
    expect(await intentOf(revision)).toMatchObject({
      status: "cleanup_started",
      cleanupAttempts: 2,
    });
  });

  test("an erasure the previous release undid is claimed, never restored", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, { action: "erase" });
    await previousErasureFence(revision);
    await changeDesired(entityId, 3, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });

    const result = await claim();
    expect(result.restoredIntentIds).toEqual([]);
    expect(result.claimed.served_unproven).toBe(1);
  });

  test("a drift repair the previous release scheduled is claimed, never restored", async () => {
    const { entityId, revision } = await servedEntity();
    await previousRepair(entityId, revision);

    const result = await claim();
    expect(result.restoredIntentIds).toEqual([]);
    expect(result.claimed.served_unproven).toBe(1);
  });

  test("this release's erasure un-names a revision the previous release kept named", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, { action: "erase" });
    await previousErasureFence(revision);
    await db.transaction(
      async (tx) =>
        await advanceCorpusProjectionErasuresTx(asTestRaw<Transaction>(tx), {
          family: "legislation",
          generation: GENERATION,
          limit: 16,
        }),
    );
    expect(await stateOf(entityId)).toEqual({
      desiredAction: "erase",
      appliedAction: null,
      appliedRevision: null,
    });
    expect((await claim()).claimed.unserved).toBe(1);
  });

  test("this release's undo of an erasure un-names a revision the previous release kept named", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, { action: "erase" });
    await previousErasureFence(revision);
    await run(sql`
      UPDATE legislation_documents SET content_hash = ${fingerprint(3)}
      WHERE id = ${entityId}
    `);
    await db.transaction(
      async (tx) =>
        await advanceCorpusProjectionDesiredStateTx(
          asTestRaw<Transaction>(tx),
          {
            family: "legislation",
            entityId: toSafeId<"legislationDocument">(entityId),
          },
        ),
    );
    expect(await stateOf(entityId)).toEqual({
      desiredAction: "upsert",
      appliedAction: null,
      appliedRevision: null,
    });
    expect((await claim()).claimed.unserved).toBe(1);
  });

  test("the walk advances past every row it reads", async () => {
    const restored: SafeId<"corpusIndexProjectionIntent">[] = [];
    for (let index = 0; index < 4; index += 1) {
      // db-await-in-loop: rows are seeded in queue order
      const { entityId, revision } = await servedEntity();
      await changeDesired(entityId, 2, {
        action: "upsert",
        fingerprint: fingerprint(1),
      });
      await previousPrepare(entityId, revision);
      restored.push(toSafeId<"corpusIndexProjectionIntent">(revision));
    }
    const first = await claim();
    expect(first.restoredIntentIds.toSorted()).toEqual(restored.toSorted());
    // Nothing the first turn read is left at the head of the queue.
    expect(await claim()).toEqual({
      leases: [],
      claimed: {
        unserved: 0,
        served_after_delete: 0,
        served_unproven: 0,
      },
      restoredIntentIds: [],
      skippedLocked: 0,
    });
  });

  test("corpus-projection.restore-guard-matches-predicate", async () => {
    await assertProperty(
      "corpus-projection.restore-guard-matches-predicate",
      fc.asyncProperty(
        fc.record({
          claimedBefore: fc.boolean(),
          lastError: fc.boolean(),
          desiredAtRecorded: fc.boolean(),
          erasedBeforeQueueing: fc.boolean(),
          desiredContent: fc.constantFrom("other" as const, "same" as const),
          changedAfterQueueing: fc.constantFrom(
            "unchanged" as const,
            "upsert" as const,
            "erase" as const,
          ),
        }),
        async ({
          claimedBefore,
          lastError,
          desiredAtRecorded,
          erasedBeforeQueueing,
          desiredContent,
          changedAfterQueueing,
        }) => {
          const upsertAs = (other: string) =>
            desiredContent === "same" ? fingerprint(0) : other;
          const { entityId, revision } = await servedEntity({
            desiredAtRecorded,
          });
          let epoch = 1;
          if (erasedBeforeQueueing) {
            epoch += 1;
            await changeDesired(
              entityId,
              epoch,
              { action: "erase" },
              { desiredAtRecorded },
            );
          }
          epoch += 1;
          await changeDesired(
            entityId,
            epoch,
            { action: "upsert", fingerprint: upsertAs(fingerprint(1)) },
            { desiredAtRecorded },
          );
          await previousPrepare(entityId, revision);
          if (claimedBefore) {
            await previousClaim(revision);
            await previousSweepCleanup(revision);
            await run(sql`
              UPDATE corpus_index_projection_intents SET last_error = NULL
              WHERE id = ${revision}
            `);
          }
          if (lastError) {
            await run(sql`
              UPDATE corpus_index_projection_intents
              SET last_error = 'projection revision scheduled by erasure'
              WHERE id = ${revision}
            `);
          }
          if (changedAfterQueueing !== "unchanged") {
            await changeDesired(
              entityId,
              epoch + 1,
              changedAfterQueueing === "upsert"
                ? { action: "upsert", fingerprint: upsertAs(fingerprint(2)) }
                : { action: "erase" },
              { desiredAtRecorded },
            );
          }
          const intents = corpusIndexProjectionIntents;
          const states = corpusIndexProjectionStates;
          const predicate = (
            await db
              .select({
                restorable: corpusIndexProjectionRevisionIsRestorable({
                  revisionId: intents.id,
                  appliedRevision: states.appliedRevision,
                  desiredAction: states.desiredAction,
                  appliedAction: states.appliedAction,
                  revisionEpoch: intents.epoch,
                  revisionFingerprint: intents.fingerprint,
                  revisionIndexId: intents.indexId,
                  cleanupAttempts: intents.cleanupAttempts,
                  revisionAppliedAt: intents.appliedAt,
                  lastError: intents.lastError,
                  appliedEpoch: states.appliedEpoch,
                  desiredEpoch: states.desiredEpoch,
                  desiredFingerprint: states.desiredFingerprint,
                  desiredIndexId: states.desiredIndexId,
                }).mapWith(Boolean),
              })
              .from(intents)
              .innerJoin(states, eq(states.appliedRevision, intents.id))
              .where(
                eq(
                  intents.id,
                  toSafeId<"corpusIndexProjectionIntent">(revision),
                ),
              )
          ).at(0)?.restorable;
          const accepted = await Result.tryPromise(
            async () =>
              await db.transaction(async (tx) => {
                await tx.execute(sql`
                  UPDATE corpus_index_projection_intents
                  SET status = 'applied', cleanup_not_before = NULL,
                      lease_token = NULL, lease_expires_at = NULL
                  WHERE id = ${revision}
                `);
                tx.rollback();
              }),
          );
          // A rollback after the update means the guard admitted it.
          const admitted =
            accepted.isErr() &&
            accepted.error.cause instanceof TransactionRollbackError;
          expect({ admitted }).toEqual({ admitted: predicate === true });
          // Whether `desired_at` was ever recorded does not matter.
          const oneChange =
            !erasedBeforeQueueing && changedAfterQueueing === "unchanged";
          expect(predicate).toBe(
            !claimedBefore &&
              !lastError &&
              changedAfterQueueing !== "erase" &&
              (oneChange || desiredContent === "same"),
          );
        },
      ),
      { numRuns: 64 },
    );
  });
});

describe("the cleanup claim's row lock", () => {
  beforeEach(async () => {
    await installProjectionDdl(true);
  });

  const lockDue = async (revision: string) =>
    await db.transaction(
      async (tx) =>
        await lockPendingCorpusProjectionCleanups(asTestRaw<Transaction>(tx), [
          toSafeId<"corpusIndexProjectionIntent">(revision),
        ]),
    );

  test("re-checks the fence and lease the unlocked page read", async () => {
    // The page saw the row due; by the lock it was claimed and requeued with
    // a later fence, or holds an unexpired lease. Neither may be claimed yet.
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await previousPrepare(entityId, revision);
    expect(await lockDue(revision)).toHaveLength(1);

    await run(sql`
      UPDATE corpus_index_projection_intents
      SET cleanup_not_before = clock_timestamp() + interval '1 hour'
      WHERE id = ${revision}
    `);
    expect(await lockDue(revision)).toEqual([]);

    await run(sql`
      UPDATE corpus_index_projection_intents
      SET cleanup_not_before = clock_timestamp() - interval '1 second',
          lease_token = ${uuid()},
          lease_expires_at = clock_timestamp() + interval '1 hour'
      WHERE id = ${revision}
    `);
    expect(await lockDue(revision)).toEqual([]);

    await run(sql`
      UPDATE corpus_index_projection_intents
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE id = ${revision}
    `);
    expect(await lockDue(revision)).toHaveLength(1);
  });
});
