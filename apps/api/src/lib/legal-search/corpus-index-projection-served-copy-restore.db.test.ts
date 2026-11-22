import { panic } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { reopenCorpusProjectionCleanupTx } from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import {
  countCorpusProjectionServedCopies,
  reconcileCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { corpusProjectionLegacyFixture } from "@/api/tests/helpers/corpus-projection-legacy-fixture";
import { optOutOfCorpusProjectionSeedingGuard } from "@/api/tests/helpers/corpus-projection-seeding-guard";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * A repair that would cost a queued, still restorable copy its proof restores
 * that copy first and then goes through, instead of holding until a cleanup
 * claim happens by. Everything else that would take a named copy away from
 * readers still holds the whole repair, and nothing it would have restored
 * moves. The served generation is the fixture's; a second, building
 * generation of the same family is owed the entity too.
 */

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const {
  generation: SERVED,
  fingerprint,
  installProjectionDdl,
  run,
  servedEntity,
  changeDesired,
  previousPrepare,
  previousClaim,
  previousRecordDelete,
  previousRepair,
  previousSweepCleanup,
  previousErasureFence,
  seedGeneration,
  subjectOf,
  claim,
  intentOf,
  uuid,
} = corpusProjectionLegacyFixture(() => db, "case_law");
const BUILDING = CORPUS_INDEX_MANIFESTS.case_law_v7;

beforeEach(async () => {
  client = await createTestPglite();
  await optOutOfCorpusProjectionSeedingGuard(client, {
    reason:
      "Stands up served copies queued for cleanup as fixtures, then checks what a repair restores before it writes.",
  });
  db = drizzle({ client });
  await seedGeneration();
  await installProjectionDdl(true);
  await db.insert(corpusIndexGenerations).values({
    family: BUILDING.family,
    generation: BUILDING.generation,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(BUILDING),
    status: "building",
  });
});

afterEach(async () => {
  await client.close();
});

const canonicalEpochOf = async (entityId: string) =>
  (
    await db
      .select({ epoch: caseLawDecisions.projectionEpoch })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, toSafeId<"caseLawDecision">(entityId)))
  ).at(0)?.epoch ?? panic("No such decision");

/** Every column of the entity's states, generation by generation. */
const statesOf = async (entityId: string) =>
  await db
    .select()
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, entityId))
    .orderBy(corpusIndexProjectionStates.generation);

const servedStateOf = async (entityId: string) =>
  (await statesOf(entityId)).find(({ generation }) => generation === SERVED) ??
  panic("No served state");

/** Every column of one revision. */
const revisionOf = async (revision: string) =>
  (
    await db
      .select()
      .from(corpusIndexProjectionIntents)
      .where(
        eq(
          corpusIndexProjectionIntents.id,
          toSafeId<"corpusIndexProjectionIntent">(revision),
        ),
      )
  ).at(0) ?? panic("No such revision");

/** The continuous walk's call: one subject, every generation it is owed. */
const continuousReconciles = async (entityId: string) =>
  await db.transaction(
    async (tx) =>
      await reconcileCorpusProjectionDesiredStateTx(
        asTestRaw<Transaction>(tx),
        subjectOf(entityId),
      ),
  );

/**
 * A served copy that replacement preparation queued for cleanup one desired
 * change after it was applied: the cleanup claim would restore it, and a
 * repair to the canonical row's content would move the desired epoch two
 * past it, costing it that proof.
 */
const queuedRestorableCopy = async () => {
  const served = await servedEntity();
  await changeDesired(served.entityId, 2, {
    action: "upsert",
    fingerprint: fingerprint(1),
  });
  await previousPrepare(served.entityId, served.revision);
  return served;
};

/**
 * The same entity served in the building generation too, with a copy of its
 * own at the canonical row's first epoch.
 */
const servedInBuilding = async (entityId: string) => {
  const revision = uuid();
  const indexId = `${BUILDING.generation}_cs_sk`;
  await run(sql`
    INSERT INTO corpus_index_projection_states (
      family, generation, entity_id, desired_action, desired_epoch,
      desired_fingerprint, desired_index_id, desired_at
    ) VALUES (
      'case_law', ${BUILDING.generation}, ${entityId}, 'upsert', 1,
      ${fingerprint(0)}, ${indexId}, statement_timestamp()
    )
  `);
  await run(sql`
    INSERT INTO corpus_index_projection_intents (
      id, family, generation, entity_id, epoch, fingerprint, index_id, status,
      lease_token, lease_expires_at
    ) VALUES (
      ${revision}, 'case_law', ${BUILDING.generation}, ${entityId}, 1,
      ${fingerprint(0)}, ${indexId}, 'reserved', ${uuid()},
      clock_timestamp() + interval '5 minutes'
    )
  `);
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'append_started',
        append_started_at = clock_timestamp() - interval '2 hours'
    WHERE id = ${revision}
  `);
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'append_committed',
        append_committed_at = clock_timestamp() - interval '2 hours',
        expected_document_count = 1
    WHERE id = ${revision}
  `);
  await run(sql`
    UPDATE corpus_index_projection_intents
    SET status = 'applied', lease_token = NULL, lease_expires_at = NULL,
        applied_at = clock_timestamp() - interval '2 hours'
    WHERE id = ${revision}
  `);
  await run(sql`
    UPDATE corpus_index_projection_states
    SET applied_action = 'upsert', applied_epoch = 1,
        applied_revision = ${revision}, applied_fingerprint = ${fingerprint(0)},
        applied_index_id = ${indexId}, applied_at = clock_timestamp(),
        work_status = 'eligible'
    WHERE entity_id = ${entityId} AND generation = ${BUILDING.generation}
  `);
  return revision;
};

describe("a repair restores a queued copy before it moves the epoch", () => {
  test("restores the copy, writes the paired refresh, and a replay changes nothing", async () => {
    const { entityId, revision } = await queuedRestorableCopy();
    const queued = await revisionOf(revision);
    const before = await servedStateOf(entityId);
    // The fixture reaches the risk: the copy is queued and never claimed.
    expect(queued).toMatchObject({
      status: "cleanup_pending",
      cleanupAttempts: 0,
      lastError: null,
    });

    const outcome = await continuousReconciles(entityId);

    if (outcome.isErr()) {
      return panic("Expected the repair to restore the copy and go through");
    }
    expect(outcome.value).toMatchObject({ epoch: 3n, changed: true });
    expect(outcome.value.servedCopies).toEqual([
      { generation: SERVED, entityId, outcome: "restored" },
    ]);
    expect(
      countCorpusProjectionServedCopies(outcome.value.servedCopies),
    ).toEqual({
      restored: 1,
      already_current: 0,
      held: 0,
    });
    // The readable revision is the same copy: pointer, content and every
    // append instant unchanged; only its lifecycle went back to `applied`.
    const restored = await revisionOf(revision);
    expect(restored).toEqual({
      ...queued,
      status: "applied",
      cleanupNotBefore: null,
      updatedAt: restored.updatedAt,
    });
    const after = await servedStateOf(entityId);
    expect(after).toMatchObject({
      appliedAction: before.appliedAction,
      appliedRevision: before.appliedRevision,
      appliedEpoch: before.appliedEpoch,
      appliedFingerprint: before.appliedFingerprint,
      appliedIndexId: before.appliedIndexId,
      appliedAt: before.appliedAt,
      desiredAction: "upsert",
      desiredEpoch: 3n,
    });
    // The paired refresh is the first write that leaves the copy two changes
    // behind with other content, so it records that instant: the legacy pass
    // reads it as a copy that fell behind now, not before its cutover.
    expect(after.desiredFingerprint).not.toBe(before.appliedFingerprint);
    expect(after.desiredAt?.getTime() ?? 0).toBeGreaterThan(
      before.desiredAt?.getTime() ?? Number.POSITIVE_INFINITY,
    );
    expect(await canonicalEpochOf(entityId)).toBe(3n);
    expect(
      (await statesOf(entityId)).map(({ generation }) => generation),
    ).toEqual([SERVED, BUILDING.generation].toSorted());

    const written = await statesOf(entityId);
    const replay = await continuousReconciles(entityId);

    expect(replay.isOk() && replay.value).toEqual({
      epoch: 3n,
      changed: false,
      generationCount: 2,
      servedCopies: [],
    });
    expect(await statesOf(entityId)).toEqual(written);
    expect(await revisionOf(revision)).toEqual(restored);
    expect(await canonicalEpochOf(entityId)).toBe(3n);
    // Nothing is left for cleanup to claim or restore.
    expect(await claim()).toMatchObject({ leases: [], restoredIntentIds: [] });
  });

  test("a cleanup claim that reaches the copy first restores it, and the writer restores nothing", async () => {
    const { entityId, revision } = await queuedRestorableCopy();

    expect((await claim()).restoredIntentIds).toEqual([
      toSafeId<"corpusIndexProjectionIntent">(revision),
    ]);
    const outcome = await continuousReconciles(entityId);

    if (outcome.isErr()) {
      return panic("Expected the repair to go through");
    }
    expect(outcome.value.servedCopies).toEqual([
      { generation: SERVED, entityId, outcome: "already_current" },
    ]);
    expect(await intentOf(revision)).toMatchObject({
      status: "applied",
      cleanupAttempts: 0,
    });
    expect(await servedStateOf(entityId)).toMatchObject({
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(revision),
      desiredEpoch: 3n,
    });
  });
});

describe("a repair with any other risk is held whole, restores included", () => {
  type Queued = { entityId: string; revision: string };
  const taken: {
    name: string;
    queue: () => Promise<Queued>;
    reached: Record<string, unknown>;
  }[] = [
    {
      name: "a cleanup claim holds",
      queue: async () => {
        const copy = await queuedRestorableCopy();
        await previousClaim(copy.revision);
        return copy;
      },
      reached: {
        status: "cleanup_started",
        cleanupAttempts: 1,
        lastError: null,
      },
    },
    {
      name: "a claim held and its delete receipt is recorded",
      queue: async () => {
        const copy = await queuedRestorableCopy();
        await previousClaim(copy.revision);
        await previousRecordDelete(copy.revision, 1);
        return copy;
      },
      reached: {
        status: "cleanup_committed",
        cleanupAttempts: 1,
        lastError: null,
      },
    },
    {
      name: "whose cleanup stalled",
      queue: async () => {
        const copy = await queuedRestorableCopy();
        await previousClaim(copy.revision);
        await previousRecordDelete(copy.revision, 1);
        await run(sql`
          UPDATE corpus_index_projection_intents
          SET status = 'cleanup_stalled', last_error = 'cleanup stalled',
              updated_at = clock_timestamp()
          WHERE id = ${copy.revision} AND status = 'cleanup_committed'
        `);
        return copy;
      },
      reached: { status: "cleanup_stalled", cleanupAttempts: 1 },
    },
    {
      name: "a claim held and its lease expired",
      queue: async () => {
        const copy = await queuedRestorableCopy();
        await previousClaim(copy.revision);
        await previousSweepCleanup(copy.revision);
        return copy;
      },
      reached: { status: "cleanup_pending", cleanupAttempts: 1 },
    },
    {
      name: "a drift repair queued with its reason",
      queue: async () => {
        const copy = await servedEntity();
        await previousRepair(copy.entityId, copy.revision);
        return copy;
      },
      reached: {
        status: "cleanup_pending",
        cleanupAttempts: 0,
        lastError: "applied census observed engine drift",
      },
    },
  ];
  for (const { name, queue, reached } of taken) {
    test(`a copy ${name} holds the repair and is not restored`, async () => {
      const { entityId, revision } = await queue();
      const states = await statesOf(entityId);
      const queued = await revisionOf(revision);
      const epoch = await canonicalEpochOf(entityId);
      expect(queued).toMatchObject(reached);

      const outcome = await continuousReconciles(entityId);

      if (outcome.isOk()) {
        return panic("Expected the repair to be held");
      }
      expect(outcome.error.copies).toEqual([
        {
          generation: SERVED,
          entityId,
          outcome: "held",
          risk: "unrestorable_cleanup",
        },
      ]);
      expect(await revisionOf(revision)).toEqual(queued);
      expect(await statesOf(entityId)).toEqual(states);
      expect(await canonicalEpochOf(entityId)).toBe(epoch);
    });
  }

  test("a settled copy holds nothing, and reopened it holds the next repair", async () => {
    const { entityId, revision } = await queuedRestorableCopy();
    await previousClaim(revision);
    await previousRecordDelete(revision, 1);
    await run(sql`
      UPDATE corpus_index_projection_intents
      SET status = 'settled', settled_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE id = ${revision} AND status = 'cleanup_committed'
    `);
    expect(await revisionOf(revision)).toMatchObject({
      status: "settled",
      cleanupAttempts: 1,
    });

    const settled = await continuousReconciles(entityId);

    // The repair moves the desired state; the copy is gone, so none is
    // reported, and the pointer stays until an append replaces it.
    expect(settled.isOk() && settled.value).toMatchObject({
      epoch: 3n,
      changed: true,
      servedCopies: [],
    });
    expect(await servedStateOf(entityId)).toMatchObject({
      desiredEpoch: 3n,
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(revision),
    });

    const { indexId } = await revisionOf(revision);
    await db.transaction(
      async (tx) =>
        await reopenCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
          intentIds: [toSafeId<"corpusIndexProjectionIntent">(revision)],
          indexId,
          errorMessage: "census found the revision after settlement",
        }),
    );
    const reopened = await revisionOf(revision);
    expect(reopened).toMatchObject({
      status: "cleanup_pending",
      cleanupAttempts: 1,
    });
    await run(sql`
      UPDATE case_law_decisions SET content_hash = ${fingerprint(2)}
      WHERE id = ${entityId}
    `);

    const held = await continuousReconciles(entityId);

    if (held.isOk()) {
      return panic("Expected the repair to be held");
    }
    expect(held.error.copies).toEqual([
      {
        generation: SERVED,
        entityId,
        outcome: "held",
        risk: "unrestorable_cleanup",
      },
    ]);
    expect(await revisionOf(revision)).toEqual(reopened);
    expect(await claim()).toMatchObject({
      claimed: { unserved: 0, served_after_delete: 1, served_unproven: 0 },
      restoredIntentIds: [],
    });
    return undefined;
  });

  test("a sibling generation at risk keeps the restorable copy queued and writes nothing", async () => {
    const { entityId, revision } = await servedEntity();
    const sibling = await servedInBuilding(entityId);
    // The served generation's copy is replaced and queued; the building
    // generation's state desires an erasure its claim has not reached yet.
    await run(sql`
      UPDATE case_law_decisions SET projection_epoch = 2 WHERE id = ${entityId}
    `);
    await run(sql`
      UPDATE corpus_index_projection_states
      SET desired_epoch = 2, desired_fingerprint = ${fingerprint(1)},
          desired_at = statement_timestamp(), updated_at = statement_timestamp()
      WHERE entity_id = ${entityId} AND generation = ${SERVED}
    `);
    await run(sql`
      UPDATE corpus_index_projection_states
      SET desired_action = 'erase', desired_epoch = 2,
          desired_fingerprint = NULL, desired_index_id = NULL,
          desired_at = statement_timestamp(), updated_at = statement_timestamp()
      WHERE entity_id = ${entityId} AND generation = ${BUILDING.generation}
    `);
    await previousPrepare(entityId, revision);
    const states = await statesOf(entityId);
    const queued = await revisionOf(revision);

    const outcome = await continuousReconciles(entityId);

    if (outcome.isOk()) {
      return panic("Expected the repair to be held");
    }
    expect(outcome.error.copies).toEqual([
      {
        generation: SERVED,
        entityId,
        outcome: "held",
        risk: "restorable_cleanup",
      },
      {
        generation: BUILDING.generation,
        entityId,
        outcome: "held",
        risk: "desired_action_change",
      },
    ]);
    expect(await revisionOf(revision)).toEqual(queued);
    expect(await intentOf(sibling)).toMatchObject({ status: "applied" });
    expect(await statesOf(entityId)).toEqual(states);
    expect(await canonicalEpochOf(entityId)).toBe(2n);
  });

  test("a copy an erasure queued stays held and queued", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, { action: "erase" });
    // The earlier release's erasure kept the pointer until settlement.
    await previousErasureFence(revision);
    const queued = await revisionOf(revision);
    expect(queued).toMatchObject({
      status: "cleanup_pending",
      lastError: "projection revision scheduled by erasure",
    });

    const outcome = await continuousReconciles(entityId);

    if (outcome.isOk()) {
      return panic("Expected the repair to be held");
    }
    expect(outcome.error.copies).toEqual([
      {
        generation: SERVED,
        entityId,
        outcome: "held",
        risk: "desired_action_change",
      },
    ]);
    expect(await revisionOf(revision)).toEqual(queued);
    expect(await servedStateOf(entityId)).toMatchObject({
      desiredAction: "erase",
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(revision),
    });
    expect(await canonicalEpochOf(entityId)).toBe(2n);
  });
});
