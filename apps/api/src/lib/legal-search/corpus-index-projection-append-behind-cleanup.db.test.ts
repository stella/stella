/**
 * A new revision appended beside an older one whose exact delete is still in
 * flight, over the real stores and their database guards, a fake engine that
 * applies a delete only once its split matures, and the flip fixture's v7 / v10
 * pair (`tests/helpers/corpus-flip-fixture.ts`): v10's hits carry their
 * revision, v7's do not.
 *
 * - v10 reserves and appends the entity while the old revision's delete waits
 *   on an immature split, so the entity is served again at once; v7 waits for
 *   that delete to settle.
 * - The old delete names only its own revision: it removes the old copy and
 *   never the new one, and settling it leaves the new revision's applied
 *   state as it was.
 * - Parity counts the entity as shown, and the route proof is not revoked.
 * - An erasure during the overlap still waits for every revision.
 */
import { panic, Result } from "better-result";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  corpusIndexRouteProofs,
} from "@/api/db/schema";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import type {
  CorpusIndexDeleteSettlement,
  CorpusIndexSettlementSplit,
} from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_FLIP_WALK_CAP,
  readCorpusIndexFlipParity,
} from "@/api/lib/legal-search/corpus-index-flip-parity";
import type { CorpusRevisionRetrieval } from "@/api/lib/legal-search/corpus-index-manifest";
import { repairAppliedCorpusProjectionDriftTx } from "@/api/lib/legal-search/corpus-index-projection-census-store";
import {
  claimCorpusProjectionCleanupSettlementTx,
  claimCorpusProjectionCleanupTx,
  CorpusProjectionCleanupSettlementProof,
  recordCorpusProjectionDeleteTx,
  releaseCorpusProjectionCleanupSettlementTx,
  settleCorpusProjectionCleanupTx,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import {
  CORPUS_INDEX_APPEND_MAX_DELETING_REVISIONS,
  CORPUS_INDEX_INTENT_APPEND_GATE,
  CORPUS_INDEX_INTENT_STATUSES,
  type CorpusIndexIntentStatus,
} from "@/api/lib/legal-search/corpus-index-projection-contract";
import {
  deleteCorpusProjectionRevisions,
  proveCorpusProjectionRevisionsPresent,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import { advanceCorpusProjectionErasuresTx } from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import { corpusIndexProjectionAppendGateIsClear } from "@/api/lib/legal-search/corpus-index-projection-sql";
import {
  abandonCorpusProjectionAppendTx,
  type CorpusProjectionIntentLease,
  proveAcceptedCorpusProjectionAppendsTx,
  recordAcceptedCorpusProjectionAppendsTx,
  reserveCorpusProjectionIntentsTx,
  startCorpusProjectionAppendTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import { readCorpusIndexRouteProofsTx } from "@/api/lib/legal-search/corpus-index-route-proof-store";
import {
  createCorpusFlipFixture,
  FLIP_V7 as V7,
  FLIP_V10 as V10,
  flipEntityId as entityId,
  type FlipGeneration as Generation,
  flipRouteOf as routeOf,
} from "@/api/tests/helpers/corpus-flip-fixture";
import { corpusProjectionMigrationDdl } from "@/api/tests/helpers/corpus-projection-migration-ddl";
import { CORPUS_PROJECTION_SEEDING_GUARD_OFF_SETTING } from "@/api/tests/helpers/corpus-projection-seeding-guard";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

type ProjectionIntentId = SafeId<"corpusIndexProjectionIntent">;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const runInTransaction = async <T>(
  work: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  await db.transaction(async (tx) => await work(asTestRaw<Transaction>(tx)));

const fixture = createCorpusFlipFixture(runInTransaction);

/** A delete task's metastore instant, well before any split this run lists. */
const DELETE_TASK_CREATED_AT = Temporal.Instant.from("2026-08-25T12:00:00Z");
/** Far enough back that every barrier and backoff of an attempt has passed. */
const ATTEMPT_AGE_MS = 60 * 60_000;
/** Long after anything this file writes: a split listed as immature until then. */
const FAR_FUTURE = Temporal.Instant.from("2100-01-01T00:00:00Z");
const QUEUED_AT = new Date("2026-08-25T00:00:00.000Z");
const fingerprint = (epoch: number) => String(epoch).padStart(64, "0");
const revision = (n: number): ProjectionIntentId =>
  toSafeId<"corpusIndexProjectionIntent">(
    `0198e331-e578-7000-a000-${String(n).padStart(12, "0")}`,
  );

const PROJECTION_REVISION_TERM = /projection_revision:"(?<revision>[^"]+)"/gu;
const revisionsIn = (query: string): string[] =>
  [...query.matchAll(PROJECTION_REVISION_TERM)].flatMap(({ groups }) => {
    const named = groups?.["revision"];
    return named === undefined ? [] : [named];
  });

/**
 * The engine of one index: documents by revision, and deletes it accepted but
 * applies only once their split matures, as Quickwit does.
 */
const held = new Map<string, number>();
/** Every delete query the engine accepted, verbatim. */
const acceptedDeletes: string[] = [];
let splitsMature = false;
let nextOpstamp = 1;

const matureSplits = () => {
  splitsMature = true;
  for (const query of acceptedDeletes) {
    // Only an exact revision disjunction is applied; anything wider is a
    // defect the assertions on `acceptedDeletes` name.
    const revisions = revisionsIn(query);
    if (
      query !==
      revisions.map((id) => `projection_revision:"${id}"`).join(" OR ")
    ) {
      return panic(`The engine was asked an unexpected delete: ${query}`);
    }
    for (const deleted of revisions) {
      held.delete(deleted);
    }
  }
};

const laggingSplit = (requiredOpstamp: number): CorpusIndexSettlementSplit => ({
  splitId: "split-immature",
  state: "Published",
  appliedOpstamp: requiredOpstamp - 1,
  publishedAt: DELETE_TASK_CREATED_AT,
  maturity: { type: "immature", maturesAt: FAR_FUTURE },
});

const engine = {
  aggregate: async ({ query }: { query: string }) =>
    Result.ok({
      projection_revisions: {
        buckets: revisionsIn(query).flatMap((key) => {
          const count = held.get(key) ?? 0;
          return count === 0 ? [] : [{ key, doc_count: count }];
        }),
        doc_count_error_upper_bound: 0,
        sum_other_doc_count: 0,
      },
    }),
  deleteByQuery: async (_indexId: string, query: string) => {
    acceptedDeletes.push(query);
    const opstamp = nextOpstamp;
    nextOpstamp += 1;
    return Result.ok({ opstamp, createdAt: DELETE_TASK_CREATED_AT });
  },
  search: async ({ query }: { query: string }) =>
    Result.ok({
      numHits: revisionsIn(query).reduce(
        (total, key) => total + (held.get(key) ?? 0),
        0,
      ),
      hits: [],
      snippets: [],
    }),
  readDeleteSettlements: async ({
    tasks,
  }: {
    tasks: readonly { requiredOpstamp: number }[];
  }) =>
    Result.ok(
      tasks.map(({ requiredOpstamp }) => {
        const lagging = splitsMature ? [] : [laggingSplit(requiredOpstamp)];
        return Result.ok({
          requiredOpstamp,
          provingSplits: 1,
          excludedSplits: 0,
          laggingSplits: lagging.length,
          minAppliedOpstamp: splitsMature
            ? requiredOpstamp
            : requiredOpstamp - 1,
          settled: splitsMature,
          laggingProvingSplits: lagging,
          laggingExcludedSplits: [],
        } satisfies CorpusIndexDeleteSettlement);
      }),
    ),
};

/** The database clock every lease, barrier and queue instant is read from. */
const databaseNow = async (): Promise<Date> => {
  const { rows } = await db.execute<{ now: Date | string }>(
    sql`SELECT clock_timestamp() AS now`,
  );
  return new Date(rows.at(0)?.now ?? panic("The database clock is missing"));
};

/** When the first attempt of each test ran, on the database clock. */
let attemptedAt: Date;

beforeEach(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  attemptedAt = new Date((await databaseNow()).getTime() - ATTEMPT_AGE_MS);
  for (const ddl of await corpusProjectionMigrationDdl()) {
    // db-await-in-loop: DDL applies in migration order
    await db.execute(sql.raw(ddl));
  }
  fixture.reset();
  held.clear();
  acceptedDeletes.length = 0;
  splitsMature = false;
  nextOpstamp = 1;
  await fixture.readyPair();
});

afterEach(async () => {
  await client.close();
});

const subject = (n: number) =>
  ({ type: "subjects", entityIds: [entityId(n)] }) as const;

/** A desired upsert the generation has not appended yet. */
const desire = async (generation: Generation, n: number) =>
  await db.insert(corpusIndexProjectionStates).values({
    family: "case_law",
    generation,
    entityId: entityId(n),
    desiredAction: "upsert",
    desiredEpoch: 1n,
    desiredFingerprint: fingerprint(1),
    desiredIndexId: routeOf(generation),
    // Queued before the first attempt, which runs on an earlier clock.
    updatedAt: QUEUED_AT,
  });

const reserve = async (
  generation: Generation,
  n: number,
  id: ProjectionIntentId,
  testNow?: Date,
): Promise<CorpusProjectionIntentLease[]> =>
  await runInTransaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(tx, {
        family: "case_law",
        generation,
        scope: subject(n),
        limit: 8,
        leaseMs: 60_000,
        testNow,
        newIntentId: () => id,
      }),
  );

const start = async (lease: CorpusProjectionIntentLease, testNow?: Date) =>
  await runInTransaction(
    async (tx) =>
      await startCorpusProjectionAppendTx(tx, {
        intentId: lease.intentId,
        leaseToken: lease.leaseToken,
        testNow,
      }),
  );

/** A first attempt whose response was lost: its revision goes to cleanup. */
const loseAppend = async (
  generation: Generation,
  n: number,
  id: ProjectionIntentId,
  /** Minutes after the first attempt this one runs, past its backoff. */
  laterByMinutes = 0,
) => {
  const at = new Date(attemptedAt.getTime() + laterByMinutes * 60_000);
  const [lease] = await reserve(generation, n, id, at);
  if (lease === undefined) {
    return panic("Expected the attempt to be reserved");
  }
  expect(await start(lease, at)).toBe("started");
  expect(
    await runInTransaction(
      async (tx) =>
        await abandonCorpusProjectionAppendTx(tx, {
          intentId: lease.intentId,
          leaseToken: lease.leaseToken,
          testNow: at,
          errorMessage: "append response was lost",
        }),
    ),
  ).toEqual({ status: "cleanup_pending" });
  // The lost request may have written its documents after all.
  held.set(id, 2);
};

/**
 * Claim the revision's cleanup, issue its exact delete and record it: the
 * revision is `cleanup_committed`, its delete waiting on an immature split.
 */
const issueDelete = async (
  generation: Generation,
  n: number,
  id: ProjectionIntentId,
) => {
  const claimed = await runInTransaction(
    async (tx) =>
      await claimCorpusProjectionCleanupTx(tx, {
        family: "case_law",
        generation,
        scope: subject(n),
        indexId: routeOf(generation),
        limit: 8,
        leaseMs: 60_000,
      }),
  );
  const lease =
    claimed.leases.find(({ intentId }) => intentId === id) ??
    panic(`Expected the cleanup of ${id} to be claimed`);
  const task = await deleteCorpusProjectionRevisions({
    client: engine,
    indexId: routeOf(generation),
    revisions: [id],
  });
  if (task.isErr()) {
    return panic("The fake engine refused a delete");
  }
  await runInTransaction(
    async (tx) =>
      await recordCorpusProjectionDeleteTx(tx, {
        intentIds: [id],
        indexId: routeOf(generation),
        leaseToken: lease.leaseToken,
        deleteOpstamp: task.value.opstamp,
        deleteTaskCreatedAt: task.value.createdAt,
      }),
  );
};

/** One settlement turn: settle what the engine proves, release the rest. */
const settlementTurn = async (generation: Generation) => {
  const leases = await runInTransaction(
    async (tx) =>
      await claimCorpusProjectionCleanupSettlementTx(tx, {
        family: "case_law",
        generation,
        indexId: routeOf(generation),
        limit: 8,
        taskLimit: 8,
        leaseMs: 60_000,
      }),
  );
  const verdicts = await CorpusProjectionCleanupSettlementProof.verifyAll({
    client: engine,
    indexId: routeOf(generation),
    leases,
  });
  const reasons: string[] = [];
  for (const { lease, result } of verdicts) {
    if (result.isErr()) {
      return panic("Settlement verification failed");
    }
    const verdict = result.value;
    if (verdict.status === "verified") {
      // db-await-in-loop: one settlement per verified lease
      await runInTransaction(
        async (tx) =>
          await settleCorpusProjectionCleanupTx(tx, { proof: verdict.proof }),
      );
      reasons.push("settled");
    } else {
      // db-await-in-loop: one release per pending lease
      await runInTransaction(
        async (tx) =>
          await releaseCorpusProjectionCleanupSettlementTx(tx, { lease }),
      );
      reasons.push(verdict.reason);
    }
  }
  return reasons;
};

/** Start, accept and prove the reserved revision at once, as a waited request does. */
const appendAndApply = async (lease: CorpusProjectionIntentLease) => {
  expect(await start(lease)).toBe("started");
  held.set(lease.intentId, 1);
  const recorded = await runInTransaction(
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
  );
  expect(recorded.at(0)?.status).toBe("accepted");
  const census = await proveCorpusProjectionRevisionsPresent({
    client: engine,
    indexId: lease.indexId,
    expected: [{ revision: lease.intentId, documentCount: 1 }],
  });
  if (census.isErr()) {
    return panic("The fake engine refused a census");
  }
  const proved = await runInTransaction(
    async (tx) =>
      await proveAcceptedCorpusProjectionAppendsTx(tx, {
        indexId: lease.indexId,
        census: census.value,
        timing: {
          type: "request_waited",
          failureMessage: "projection append is not fully searchable",
        },
      }),
  );
  expect(proved.at(0)?.status).toBe("applied");
};

const stateOf = async (generation: Generation, n: number) =>
  (
    await db
      .select()
      .from(corpusIndexProjectionStates)
      .where(
        and(
          eq(corpusIndexProjectionStates.generation, generation),
          eq(corpusIndexProjectionStates.entityId, entityId(n)),
        ),
      )
  ).at(0) ?? panic(`No ${generation} state for decision ${n}`);

const statusOf = async (id: ProjectionIntentId) =>
  (
    await db
      .select({ status: corpusIndexProjectionIntents.status })
      .from(corpusIndexProjectionIntents)
      .where(eq(corpusIndexProjectionIntents.id, id))
  ).at(0)?.status ?? panic(`No revision ${id}`);

const appliedFields = ({
  appliedAction,
  appliedEpoch,
  appliedRevision,
  appliedFingerprint,
  appliedIndexId,
  appliedAt,
  appliedRevisionSettled,
}: Awaited<ReturnType<typeof stateOf>>) => ({
  appliedAction,
  appliedEpoch,
  appliedRevision,
  appliedFingerprint,
  appliedIndexId,
  appliedAt,
  appliedRevisionSettled,
});

const readParity = async (pageSize = 8) => {
  const parity = await readCorpusIndexFlipParity({
    runInTransaction,
    family: "case_law",
    candidate: V10,
    exemptMinutes: 0,
    coverage: { pageSize, pageBudget: 100, resumeFrom: null },
  });
  return Result.isOk(parity)
    ? parity.value.verdict
    : panic(`Flip parity read failed: ${parity.error.message}`, parity.error);
};

const routeProofRows = async (generation: Generation) =>
  await db
    .select({
      indexId: corpusIndexRouteProofs.indexId,
      passNumber: corpusIndexRouteProofs.passNumber,
      provenPassNumber: corpusIndexRouteProofs.provenPassNumber,
      revokedAt: corpusIndexRouteProofs.revokedAt,
    })
    .from(corpusIndexRouteProofs)
    .where(eq(corpusIndexRouteProofs.generation, generation))
    .orderBy(corpusIndexRouteProofs.indexId);

const routeProofsRead = async (generation: Generation) =>
  (
    await runInTransaction(
      async (tx) =>
        await readCorpusIndexRouteProofsTx(tx, {
          family: "case_law",
          generation,
        }),
    )
  ).type;

test("a stored-revision generation appends beside an old revision whose delete waits on an immature split", async () => {
  await fixture.seedShown(V7, 4);
  await desire(V10, 4);
  const old = revision(1);
  await loseAppend(V10, 4, old);
  await issueDelete(V10, 4, old);
  expect(await settlementTurn(V10)).toEqual(["immature_split"]);
  expect(await statusOf(old)).toBe("cleanup_committed");
  const proofsBefore = await routeProofRows(V10);
  expect(await routeProofsRead(V10)).toBe("all_current");
  // The candidate does not show a decision the serving generation shows.
  expect((await readParity()).type).toBe("regressions");

  const fresh = revision(2);
  const [lease] = await reserve(V10, 4, fresh);
  if (lease === undefined) {
    return panic("Expected the retry to be reserved beside the delete");
  }
  // The same desired epoch, as a new revision.
  expect(lease.epoch).toBe(1n);
  await appendAndApply(lease);
  const served = await stateOf(V10, 4);
  expect(served.appliedRevision).toBe(fresh);
  expect(await statusOf(old)).toBe("cleanup_committed");
  // Readers are given the new copy, so the candidate shows the decision.
  expect(await readParity()).toEqual({ type: "no_regression" });
  // Nothing about the overlap revoked or replaced a route proof.
  expect(await routeProofRows(V10)).toEqual(proofsBefore);
  expect(await routeProofsRead(V10)).toBe("all_current");

  // The old delete settles later and takes only its own revision.
  // Exactly the old revision's term: no other field, no other revision.
  expect(acceptedDeletes).toEqual([`projection_revision:"${old}"`]);
  matureSplits();
  expect(held.has(old)).toBe(false);
  expect(held.get(fresh)).toBe(1);
  expect(await settlementTurn(V10)).toEqual(["settled"]);
  expect(await statusOf(old)).toBe("settled");
  expect(await statusOf(fresh)).toBe("applied");
  const after = await stateOf(V10, 4);
  expect(appliedFields(after)).toEqual(appliedFields(served));
  expect(after.appliedRevisionSettled).toBe(false);
  expect(await readParity()).toEqual({ type: "no_regression" });
  expect(await routeProofRows(V10)).toEqual(proofsBefore);
  // Converged: nothing more to reserve.
  expect(await reserve(V10, 4, revision(3))).toEqual([]);
});

test("a query-only generation waits for the old revision's delete to settle", async () => {
  // Decision 5's canonical row and a v10 copy, so the v7 state has a row.
  await fixture.seedShown(V10, 5);
  await desire(V7, 5);
  const old = revision(11);
  await loseAppend(V7, 5, old);
  await issueDelete(V7, 5, old);
  expect(await settlementTurn(V7)).toEqual(["immature_split"]);

  // Hits there cannot tell the copies apart: however late, it waits.
  const farFuture = new Date(FAR_FUTURE.epochMilliseconds);
  expect(await reserve(V7, 5, revision(12), farFuture)).toEqual([]);
  expect(await reserve(V7, 5, revision(12))).toEqual([]);

  matureSplits();
  expect(await settlementTurn(V7)).toEqual(["settled"]);
  const [lease] = await reserve(V7, 5, revision(12));
  expect(lease?.intentId).toBe(revision(12));
});

test("a drift-retired copy is appended anew at once only where hits carry their revision", async () => {
  // Decision 1 is shown by both generations; a census finds both copies
  // drifted.
  const repairedAt = await databaseNow();
  for (const generation of [V10, V7] as const) {
    const drifted =
      (await stateOf(generation, 1)).appliedRevision ??
      panic("Expected decision 1 to be shown");
    // db-await-in-loop: one repair per generation
    await runInTransaction(
      async (tx) =>
        await repairAppliedCorpusProjectionDriftTx(tx, {
          family: "case_law",
          generation,
          indexId: routeOf(generation),
          revisions: [drifted],
        }),
    );
    // db-await-in-loop: the retired revision's status, per generation
    expect(await statusOf(drifted)).toBe("cleanup_pending");
  }

  const stored = await stateOf(V10, 1);
  expect(stored.appliedRevision).toBeNull();
  // Runnable now, not at the retired revision's settlement bound.
  expect(stored.updatedAt.getTime()).toBeLessThanOrEqual(
    (await databaseNow()).getTime(),
  );
  const [lease] = await reserve(V10, 1, revision(21));
  expect(lease?.intentId).toBe(revision(21));

  const queryOnly = await stateOf(V7, 1);
  expect(queryOnly.appliedRevision).toBeNull();
  // Queued for when its retired revision can have settled.
  expect(queryOnly.updatedAt.getTime()).toBeGreaterThan(
    repairedAt.getTime() + 60 * 60_000,
  );
  expect(await reserve(V7, 1, revision(22))).toEqual([]);
});

test("an erasure during the overlap fences the new revision and waits for both", async () => {
  await fixture.seedShown(V7, 6);
  await desire(V10, 6);
  const old = revision(31);
  await loseAppend(V10, 6, old);
  await issueDelete(V10, 6, old);
  const [lease] = await reserve(V10, 6, revision(32));
  if (lease === undefined) {
    return panic("Expected the retry to be reserved beside the delete");
  }
  await appendAndApply(lease);

  // The decision is erased canonically, at a newer projection epoch.
  await runInTransaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config(${CORPUS_PROJECTION_SEEDING_GUARD_OFF_SETTING}, 'off', true)`,
    );
    await tx
      .update(caseLawDecisions)
      .set({ projectionEpoch: 2n })
      .where(eq(caseLawDecisions.id, toSafeId<"caseLawDecision">(entityId(6))));
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
          eq(corpusIndexProjectionStates.generation, V10),
          eq(corpusIndexProjectionStates.entityId, entityId(6)),
        ),
      );
  });
  const erase = async () =>
    await runInTransaction(
      async (tx) =>
        await advanceCorpusProjectionErasuresTx(tx, {
          family: "case_law",
          generation: V10,
          scope: subject(6),
          limit: 8,
        }),
    );

  const first = await erase();
  expect(first.scheduledRevisions).toEqual([revision(32)]);
  expect(first.appliedEntityIds).toEqual([]);
  const fenced = await stateOf(V10, 6);
  expect(fenced.appliedRevision).toBeNull();
  expect(fenced.appliedAction).toBeNull();
  // An erasure is never appended.
  expect(await reserve(V10, 6, revision(33))).toEqual([]);

  // The old revision settling is not enough: the new one is still owed a
  // delete.
  matureSplits();
  expect(await settlementTurn(V10)).toEqual(["settled"]);
  expect(await statusOf(old)).toBe("settled");
  expect(await statusOf(revision(32))).toBe("cleanup_pending");
  expect((await erase()).appliedEntityIds).toEqual([]);
  expect((await stateOf(V10, 6)).appliedAction).toBeNull();
});

test("the reservation gate holds back exactly what the contract says, for any mix of other revisions", async () => {
  const gateHolds = async (
    statuses: readonly CorpusIndexIntentStatus[],
    retrieval: CorpusRevisionRetrieval,
  ): Promise<boolean> => {
    const values =
      statuses.length === 0
        ? sql`SELECT NULL::text AS status WHERE false`
        : sql`VALUES ${sql.join(
            statuses.map((status) => sql`(${status}::text)`),
            sql`, `,
          )}`;
    const { rows } = await db.execute<{ clear: boolean }>(
      sql`SELECT ${corpusIndexProjectionAppendGateIsClear({
        retrieval,
        others: (condition) => sql`
          SELECT 1 FROM (${values}) AS other (status)
          WHERE ${condition(sql`other.status`)}`,
      })} AS clear`,
    );
    return !(rows.at(0)?.clear ?? panic("The gate probe returned no row"));
  };
  const stored: CorpusRevisionRetrieval = {
    type: "stored",
    field: "projection_revision",
  };
  const queryOnly: CorpusRevisionRetrieval = {
    type: "query_only",
    field: "projection_revision",
  };
  await assertProperty(
    "corpus-projection-append-gate-matches-contract",
    fc.asyncProperty(
      fc.array(fc.constantFrom(...CORPUS_INDEX_INTENT_STATUSES), {
        maxLength: 6,
      }),
      async (statuses) => {
        const gate = statuses.map(
          (status) => CORPUS_INDEX_INTENT_APPEND_GATE[status],
        );
        // At most one revision being deleted may sit beside a new append.
        expect(await gateHolds(statuses, stored)).toBe(
          gate.includes("holds") ||
            gate.filter((disposition) => disposition === "deleting").length >
              CORPUS_INDEX_APPEND_MAX_DELETING_REVISIONS,
        );
        expect(await gateHolds(statuses, queryOnly)).toBe(
          gate.some((disposition) => disposition !== "quiescent"),
        );
      },
    ),
    { numRuns: 200 },
  );
});

test("one append per entity and epoch: a second reservation beside the delete finds nothing", async () => {
  await fixture.seedShown(V7, 7);
  await desire(V10, 7);
  const old = revision(41);
  await loseAppend(V10, 7, old);
  await issueDelete(V10, 7, old);
  const [lease] = await reserve(V10, 7, revision(42));
  expect(lease?.intentId).toBe(revision(42));
  // The reserved retry holds the entity; neither a second walk nor a second
  // row at the same epoch can join it.
  expect(await reserve(V10, 7, revision(43))).toEqual([]);
  expect(
    await db
      .select({ id: corpusIndexProjectionIntents.id })
      .from(corpusIndexProjectionIntents)
      .where(
        and(
          eq(corpusIndexProjectionIntents.generation, V10),
          eq(corpusIndexProjectionIntents.entityId, entityId(7)),
        ),
      )
      .orderBy(corpusIndexProjectionIntents.id),
  ).toEqual([{ id: old }, { id: revision(42) }]);
});

/**
 * `count` decisions both generations show, each replaced in v10 beside the
 * delete of its first revision: v7 names its one copy, v10 names its second
 * and holds the first in `cleanup_committed`. Written in bulk through every
 * guarded transition, so the database admits each row as the stores would.
 */
const seedReplacedBesideDeletes = async (count: number) => {
  const first = 100_000;
  const ids = (prefix: string) =>
    `('0198e331-e578-7000-${prefix}-' || lpad(n::text, 12, '0'))::uuid`;
  const entities = ids("8000");
  const range = `generate_series(${first + 1}, ${first + count}) AS n`;
  const revisionsOf = (prefix: string) =>
    `(SELECT ${ids(prefix)} FROM ${range})`;
  const statements = [
    `SELECT set_config('${CORPUS_PROJECTION_SEEDING_GUARD_OFF_SETTING}', 'off', true)`,
    `INSERT INTO case_law_sources (id, adapter_key, name)
     VALUES ('0198e331-e578-7000-b000-000000000001', 'overlap-fixture', 'Overlap fixture')`,
    `INSERT INTO case_law_decisions
       (id, source_id, case_number, court, country, language, content_hash,
        projection_epoch)
     SELECT ${entities}, '0198e331-e578-7000-b000-000000000001',
       n::text || ' As 1/2026', 'Naczelny Sąd Administracyjny', 'POL', 'pl',
       lpad(to_hex(n), 64, 'c'), 1
     FROM ${range}`,
  ];
  for (const generation of [V7, V10] as const) {
    statements.push(`INSERT INTO corpus_index_projection_states
       (family, generation, entity_id, desired_action, desired_epoch,
        desired_fingerprint, desired_index_id, updated_at)
     SELECT 'case_law', '${generation}', ${entities}, 'upsert', 1,
       '${fingerprint(1)}', '${routeOf(generation)}', '2026-08-25'
     FROM ${range}`);
  }
  /** One revision per entity, carried from reserved to applied. */
  const applyRevisions = (generation: Generation, prefix: string) => [
    `INSERT INTO corpus_index_projection_intents
       (id, family, generation, entity_id, epoch, fingerprint, index_id,
        status, lease_token, lease_expires_at)
     SELECT ${ids(prefix)}, 'case_law', '${generation}', ${entities}, 1,
       '${fingerprint(1)}', '${routeOf(generation)}', 'reserved',
       gen_random_uuid(), clock_timestamp() + interval '5 minutes'
     FROM ${range}`,
    `UPDATE corpus_index_projection_intents
     SET status = 'append_started', append_started_at = '2026-08-26'
     WHERE id IN ${revisionsOf(prefix)}`,
    `UPDATE corpus_index_projection_intents
     SET status = 'append_committed', append_committed_at = '2026-08-26',
       expected_document_count = 1
     WHERE id IN ${revisionsOf(prefix)}`,
    `UPDATE corpus_index_projection_intents
     SET status = 'applied', lease_token = NULL, lease_expires_at = NULL,
       applied_at = '2026-08-26'
     WHERE id IN ${revisionsOf(prefix)}`,
  ];
  const nameRevisions = (generation: Generation, prefix: string) =>
    `UPDATE corpus_index_projection_states state
     SET applied_action = 'upsert', applied_epoch = 1,
       applied_revision = revision.id, applied_fingerprint = revision.fingerprint,
       applied_index_id = revision.index_id, applied_at = '2026-08-26'
     FROM corpus_index_projection_intents revision
     WHERE revision.id IN ${revisionsOf(prefix)}
       AND state.family = revision.family
       AND state.generation = revision.generation
       AND state.entity_id = revision.entity_id`;
  statements.push(
    ...applyRevisions(V7, "9007"),
    nameRevisions(V7, "9007"),
    // v10's first revision: applied, never named here, then retired.
    ...applyRevisions(V10, "9a10"),
    `UPDATE corpus_index_projection_intents
     SET status = 'cleanup_pending', append_publish_barrier_at = '2026-08-26',
       cleanup_not_before = '2026-08-26'
     WHERE id IN ${revisionsOf("9a10")}`,
    // Its replacement, at the same epoch, applied and named.
    ...applyRevisions(V10, "9b10"),
    nameRevisions(V10, "9b10"),
    // The first revision's delete, issued and waiting on its split.
    `UPDATE corpus_index_projection_intents
     SET status = 'cleanup_started', cleanup_started_at = '2026-08-27',
       cleanup_attempts = 1
     WHERE id IN ${revisionsOf("9a10")}`,
    `UPDATE corpus_index_projection_intents
     SET status = 'cleanup_committed', delete_opstamp = 3,
       delete_task_created_at = '2026-08-27'
     WHERE id IN ${revisionsOf("9a10")}`,
  );
  await runInTransaction(async (tx) => {
    for (const statement of statements) {
      // db-await-in-loop: the fixture's transitions, in order
      await tx.execute(sql.raw(statement));
    }
  });
};

// timeout: seeds a walk cap's worth of decisions through every guarded transition in PGlite.
test("more deletes in flight than the parity walk's cap, each beside an applied replacement, still read as no regression", async () => {
  const count = CORPUS_INDEX_FLIP_WALK_CAP + 1;
  await seedReplacedBesideDeletes(count);
  const deleting = await db
    .select({ id: corpusIndexProjectionIntents.id })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.generation, V10),
        eq(corpusIndexProjectionIntents.status, "cleanup_committed"),
      ),
    );
  expect(deleting.length).toBe(count);
  expect(await readParity(5000)).toEqual({ type: "no_regression" });
}, 120_000);

test("a second revision being deleted holds the append back until one of them settles", async () => {
  await fixture.seedShown(V7, 8);
  await desire(V10, 8);
  // Two lost attempts: the second runs beside the first one's delete.
  await loseAppend(V10, 8, revision(51));
  await loseAppend(V10, 8, revision(52), 5);
  expect(await statusOf(revision(51))).toBe("cleanup_pending");
  expect(await statusOf(revision(52))).toBe("cleanup_pending");
  // Two older copies may be searchable; a third attempt waits.
  expect(await reserve(V10, 8, revision(53))).toEqual([]);

  await issueDelete(V10, 8, revision(51));
  matureSplits();
  expect(await settlementTurn(V10)).toEqual(["settled"]);
  expect(await statusOf(revision(51))).toBe("settled");
  // One left being deleted: the append runs beside it.
  const [lease] = await reserve(V10, 8, revision(53));
  expect(lease?.intentId).toBe(revision(53));
});
