import { panic } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  buildCorpusIndexProjectionDesiredStateValues,
  reconcileCorpusProjectionDesiredStateTx,
  writeRepairedCorpusProjectionDesiredStatesTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { advanceCorpusProjectionErasuresTx } from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import { corpusProjectionLegacyFixture } from "@/api/tests/helpers/corpus-projection-legacy-fixture";
import { optOutOfCorpusProjectionSeedingGuard } from "@/api/tests/helpers/corpus-projection-seeding-guard";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The desired-state writer owns served-copy protection: a repair (a write
 * with no canonical change behind it) never takes a copy away from readers,
 * whichever repair runs and in whichever order. The served generation is the
 * fixture's; a second, building generation of the same family is owed the
 * entity too, so one reconciliation writes both.
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
  seedGeneration,
  subjectOf,
  claim,
  intentOf,
  stateOf,
} = corpusProjectionLegacyFixture(() => db, "case_law");
const BUILDING = CORPUS_INDEX_MANIFESTS.case_law_v7;

beforeEach(async () => {
  client = await createTestPglite();
  await optOutOfCorpusProjectionSeedingGuard(client, {
    reason:
      "Stands up served copies and pending erasures as fixtures, then checks which desired writes the owner holds.",
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

const generationsOf = async (entityId: string) =>
  (
    await db
      .select({ generation: corpusIndexProjectionStates.generation })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, entityId))
      .orderBy(corpusIndexProjectionStates.generation)
  ).map(({ generation }) => generation);

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
 * A bounded repair's call, the shape a source-wide refresh makes: the
 * canonical epoch advances by one and every generation is written at it.
 */
const boundedRepairWrites = async (entityId: string) => {
  // Read before the transaction: the test database has one connection.
  const epoch = (await canonicalEpochOf(entityId)) + 1n;
  return await db.transaction(async (transaction) => {
    const tx = asTestRaw<Transaction>(transaction);
    const subject = {
      family: "case_law",
      entityId: toSafeId<"caseLawDecision">(entityId),
    } as const;
    return await writeRepairedCorpusProjectionDesiredStatesTx(tx, {
      epochs: {
        family: "case_law",
        epochs: [{ id: subject.entityId, epoch }],
      },
      values: [SERVED, BUILDING.generation].map((generation) =>
        buildCorpusIndexProjectionDesiredStateValues({
          subject,
          generation,
          epoch,
          // The content does not matter to the hold: the served state's
          // action changes either way.
          descriptor: {
            action: "upsert",
            fingerprint: fingerprint(3),
            indexId: `${generation}_cs_sk`,
          },
        }),
      ),
    });
  });
};

/** A served copy whose state desires an erasure no claim has reached yet. */
const pendingErasure = async () => {
  const served = await servedEntity();
  // The canonical row still projects an upsert; only the state was erased.
  await changeDesired(served.entityId, 2, { action: "erase" });
  return served;
};

describe("a repair that would take a served copy away is held", () => {
  test("the continuous walk going first leaves the copy named and writes nothing", async () => {
    const { entityId, revision } = await pendingErasure();

    const outcome = await continuousReconciles(entityId);

    if (outcome.isOk()) {
      panic("Expected the repair to be held");
    }
    expect(outcome.error.copies).toEqual([
      {
        generation: SERVED,
        entityId,
        outcome: "held",
        risk: "desired_action_change",
      },
    ]);
    expect(await stateOf(entityId)).toEqual({
      desiredAction: "erase",
      appliedAction: "upsert",
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(revision),
    });
    expect(await intentOf(revision)).toMatchObject({
      status: "applied",
      lastError: null,
    });
    // Neither the canonical epoch nor the building generation moved.
    expect(await canonicalEpochOf(entityId)).toBe(2n);
    expect(await generationsOf(entityId)).toEqual([SERVED]);
  });

  test("a bounded repair going second is held too, not skipped as current", async () => {
    const { entityId, revision } = await pendingErasure();
    expect((await continuousReconciles(entityId)).isErr()).toBe(true);

    const second = await boundedRepairWrites(entityId);

    if (second.isOk()) {
      panic("Expected the second repair to be held");
    }
    expect(second.error.copies).toEqual([
      {
        generation: SERVED,
        entityId,
        outcome: "held",
        risk: "desired_action_change",
      },
    ]);
    expect(await stateOf(entityId)).toMatchObject({
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(revision),
    });
    expect(await canonicalEpochOf(entityId)).toBe(2n);
    expect(await generationsOf(entityId)).toEqual([SERVED]);
  });

  test("once the erasure settles both repairs go through", async () => {
    const { entityId, revision } = await pendingErasure();
    expect((await continuousReconciles(entityId)).isErr()).toBe(true);

    await db.transaction(
      async (tx) =>
        await advanceCorpusProjectionErasuresTx(asTestRaw<Transaction>(tx), {
          family: "case_law",
          generation: SERVED,
          limit: 16,
        }),
    );
    expect(await intentOf(revision)).toMatchObject({
      status: "cleanup_pending",
      lastError: "projection revision scheduled by erasure",
    });

    const outcome = await continuousReconciles(entityId);
    expect(outcome.isOk() && outcome.value.changed).toBe(true);
    expect(await stateOf(entityId)).toEqual({
      desiredAction: "upsert",
      appliedAction: null,
      appliedRevision: null,
    });
    expect(await generationsOf(entityId)).toEqual(
      [SERVED, BUILDING.generation].toSorted(),
    );
    expect((await boundedRepairWrites(entityId)).isOk()).toBe(true);
  });

  test("a queued copy the cleanup claim would restore is restored before the repair", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await previousPrepare(entityId, revision);

    const outcome = await continuousReconciles(entityId);

    if (outcome.isErr()) {
      panic("Expected the repair to restore the copy and go through");
    }
    expect(outcome.value.servedCopies).toEqual([
      { generation: SERVED, entityId, outcome: "restored" },
    ]);
    expect(await intentOf(revision)).toMatchObject({ status: "applied" });
    expect(await stateOf(entityId)).toMatchObject({
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(revision),
    });
    expect(await canonicalEpochOf(entityId)).toBe(3n);
    expect((await claim()).restoredIntentIds).toEqual([]);
  });

  test("a copy two changes behind is not handed to the legacy pass by an epoch jump", async () => {
    const { entityId, revision } = await servedEntity();
    await changeDesired(entityId, 2, {
      action: "upsert",
      fingerprint: fingerprint(1),
    });
    await changeDesired(entityId, 3, {
      action: "upsert",
      fingerprint: fingerprint(2),
    });
    // The canonical row moved on without its states, so the repair would
    // write an epoch more than one past the state's.
    await run(sql`
      UPDATE case_law_decisions SET projection_epoch = 5 WHERE id = ${entityId}
    `);

    const outcome = await continuousReconciles(entityId);

    if (outcome.isOk()) {
      panic("Expected the repair to be held");
    }
    expect(outcome.error.copies).toEqual([
      {
        generation: SERVED,
        entityId,
        outcome: "held",
        risk: "legacy_retirement",
      },
    ]);
    expect(await intentOf(revision)).toMatchObject({ status: "applied" });
    expect(await canonicalEpochOf(entityId)).toBe(5n);
  });

  test("a repair that takes no copy away is written", async () => {
    const { entityId, revision } = await servedEntity();

    const outcome = await continuousReconciles(entityId);

    expect(outcome.isOk() && outcome.value.changed).toBe(true);
    expect(await generationsOf(entityId)).toEqual(
      [SERVED, BUILDING.generation].toSorted(),
    );
    const served = (
      await db
        .select({
          desiredEpoch: corpusIndexProjectionStates.desiredEpoch,
          appliedRevision: corpusIndexProjectionStates.appliedRevision,
        })
        .from(corpusIndexProjectionStates)
        .where(
          and(
            eq(corpusIndexProjectionStates.entityId, entityId),
            eq(corpusIndexProjectionStates.generation, SERVED),
          ),
        )
    ).at(0);
    expect(served).toEqual({
      desiredEpoch: 2n,
      appliedRevision: toSafeId<"corpusIndexProjectionIntent">(revision),
    });
  });
});
