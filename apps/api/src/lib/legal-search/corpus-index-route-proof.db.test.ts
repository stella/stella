/**
 * A route's readiness proof against a real PostgreSQL schema and a fake
 * engine that answers the census aggregation, the document count and the
 * index incarnation from maps: a clean pass proves the route on the
 * incarnation it walked, projection writes during a pass never restart it,
 * drift found by a page is repaired and revokes the proof in the repair's
 * transaction, a page read across a revocation or by a second runner is never
 * recorded, and only declared, attested routes can be walked at all.
 */
import { panic, Result } from "better-result";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  corpusIndexRouteProofs,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { registeredCorpusIndexGroups } from "@/api/lib/legal-search/corpus-index-group-contract";
import {
  attestCorpusIndexGroupEnrollmentTx,
  bindCorpusIndexGroupEnrollmentTx,
  withdrawCorpusIndexGroupEnrollmentTx,
} from "@/api/lib/legal-search/corpus-index-group-enrollment-store";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { proveCorpusProjectionRevisionsPresent } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { proveAcceptedCorpusProjectionAppendsTx } from "@/api/lib/legal-search/corpus-index-projection-store";
import {
  advanceCorpusIndexRouteProof,
  type CorpusIndexRouteProofAdvance,
  type CorpusIndexRouteProofWorkUnit,
} from "@/api/lib/legal-search/corpus-index-route-proof";
import {
  checkCorpusIndexRouteProofIncarnations,
  type CorpusIndexRoute,
  readCorpusIndexRouteProofsTx,
  recordCorpusIndexRouteCensusPageTx,
  revokeCorpusIndexRouteProofTx,
  startCorpusIndexRouteCensusPageTx,
} from "@/api/lib/legal-search/corpus-index-route-proof-store";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const MANIFEST = CORPUS_INDEX_MANIFESTS.case_law_v10;

/** A group the generation was created with: the manifest attests it. */
const ROUTE = {
  family: "case_law",
  generation: "case_law_v10",
  indexId: "case_law_v10_pol",
} as const satisfies CorpusIndexRoute;

/** A group under a contract of its own: attested only by its enrollment. */
const ENROLLED = {
  ...ROUTE,
  indexId: "case_law_v10_cze",
} as const satisfies CorpusIndexRoute;
const ENROLLED_GROUP = "cze";

const PAGE = 2;
const APPLIED_AT = new Date("2026-08-26T00:00:00.000Z");
const fingerprint = (epoch: number) => String(epoch).padStart(64, "0");
const entityId = (index: number) =>
  `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
const revisionId = (index: number) =>
  toSafeId<"corpusIndexProjectionIntent">(
    `00000000-0000-4000-9000-${String(index + 1).padStart(12, "0")}`,
  );

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

/** What the fake engine holds: projection revision to index and count. */
let engine: Map<string, { indexId: string; count: number }>;
/** Documents an index holds that PostgreSQL knows nothing of. */
let orphans: Map<string, number>;
/** The incarnation of each index id; absent means the index is missing. */
let incarnations: Map<string, string>;
/** An index recreated at the given incarnation read, counted across calls. */
let switchIncarnation: { atRead: number; indexId: string; to: string } | null;
let reads: { census: number; count: number; incarnation: number };
let admitted: CorpusIndexRouteProofWorkUnit[];

const PROJECTION_REVISION_TERM = /projection_revision:"(?<revision>[^"]+)"/gu;

const engineClient = {
  aggregate: async ({ query }: { indexId: string; query: string }) => {
    reads.census += 1;
    const buckets = [...query.matchAll(PROJECTION_REVISION_TERM)].flatMap(
      ({ groups }) => {
        const revision = groups?.["revision"];
        const count =
          revision === undefined ? undefined : engine.get(revision)?.count;
        return count === undefined || count === 0
          ? []
          : [{ key: revision, doc_count: count }];
      },
    );
    return Result.ok({
      projection_revisions: {
        buckets,
        doc_count_error_upper_bound: 0,
        sum_other_doc_count: 0,
      },
    });
  },
  search: async ({
    indexId,
    maxHits,
  }: {
    indexId: string;
    maxHits: number;
  }) => {
    reads.count += 1;
    expect(maxHits).toBe(0);
    const known = [...engine.values()]
      .filter((held) => held.indexId === indexId)
      .reduce((total, held) => total + held.count, 0);
    return Result.ok({
      numHits: known + (orphans.get(indexId) ?? 0),
      hits: [],
      snippets: [],
    });
  },
  readIndexIncarnation: async (indexId: string) => {
    reads.incarnation += 1;
    if (
      switchIncarnation !== null &&
      switchIncarnation.indexId === indexId &&
      reads.incarnation >= switchIncarnation.atRead
    ) {
      incarnations.set(indexId, switchIncarnation.to);
      switchIncarnation = null;
    }
    const incarnation = incarnations.get(indexId);
    return Result.ok(
      incarnation === undefined
        ? ({ type: "missing" } as const)
        : ({ type: "present", incarnation } as const),
    );
  },
};

const runInTransaction = async <T>(
  work: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  await db.transaction(async (tx) => await work(asTestRaw<Transaction>(tx)));

/** One decision the projection applied to the route, held by the engine. */
const seedApplied = async (index: number, indexId: string = ROUTE.indexId) => {
  const revision = revisionId(index);
  await db.insert(corpusIndexProjectionIntents).values({
    id: revision,
    family: ROUTE.family,
    generation: ROUTE.generation,
    entityId: entityId(index),
    epoch: 1n,
    fingerprint: fingerprint(1),
    indexId,
    status: "applied",
    appendStartedAt: APPLIED_AT,
    appendCommittedAt: APPLIED_AT,
    expectedDocumentCount: 3,
    appliedAt: APPLIED_AT,
  });
  await db.insert(corpusIndexProjectionStates).values({
    family: ROUTE.family,
    generation: ROUTE.generation,
    entityId: entityId(index),
    desiredAction: "upsert",
    desiredEpoch: 1n,
    desiredFingerprint: fingerprint(1),
    desiredIndexId: indexId,
    appliedAction: "upsert",
    appliedEpoch: 1n,
    appliedRevision: revision,
    appliedFingerprint: fingerprint(1),
    appliedIndexId: indexId,
    appliedAt: APPLIED_AT,
  });
  engine.set(revision, { indexId, count: 3 });
};

/** One revision whose delete the projection proved: the engine must not hold it. */
const seedSettled = async (index: number) => {
  await db.insert(corpusIndexProjectionIntents).values({
    id: revisionId(index),
    family: ROUTE.family,
    generation: ROUTE.generation,
    entityId: entityId(index),
    epoch: 1n,
    fingerprint: fingerprint(1),
    indexId: ROUTE.indexId,
    status: "settled",
    appendStartedAt: APPLIED_AT,
    appendCommittedAt: APPLIED_AT,
    expectedDocumentCount: 3,
    appliedAt: APPLIED_AT,
    appendPublishBarrierAt: APPLIED_AT,
    cleanupNotBefore: APPLIED_AT,
    cleanupStartedAt: APPLIED_AT,
    cleanupAttempts: 1,
    deleteOpstamp: 1n,
    deleteTaskCreatedAt: APPLIED_AT,
    settledAt: APPLIED_AT,
  });
};

/**
 * One offline delivery the indexer was killed before publishing: withdrawn
 * on an empty census, so the engine must not hold it.
 */
const seedWithdrawn = async (index: number) => {
  await db.insert(corpusIndexProjectionIntents).values({
    id: revisionId(index),
    family: ROUTE.family,
    generation: ROUTE.generation,
    entityId: entityId(index),
    epoch: 1n,
    fingerprint: fingerprint(1),
    indexId: ROUTE.indexId,
    status: "withdrawn",
    appendDelivery: "offline_indexer",
    appendRequestId: "00000000-0000-4000-a000-000000000001",
    appendRequestRevisionCount: 1,
    appendFault: "killed",
    appendStartedAt: APPLIED_AT,
    appendCommittedAt: APPLIED_AT,
    appendPublishBarrierAt: APPLIED_AT,
    expectedDocumentCount: 3,
  });
};

const governor = async <Value>(
  unit: CorpusIndexRouteProofWorkUnit,
  work: () => Promise<Value>,
): Promise<Value> => {
  admitted.push(unit);
  return await work();
};

const advance = async (
  route: CorpusIndexRoute = ROUTE,
): Promise<CorpusIndexRouteProofAdvance> => {
  const advanced = await advanceCorpusIndexRouteProof({
    runInTransaction,
    client: engineClient,
    admit: governor,
    route,
    limit: PAGE,
  });
  return Result.isOk(advanced)
    ? advanced.value
    : panic(`Route census failed: ${advanced.error.message}`);
};

const stepName = (step: CorpusIndexRouteProofAdvance): string =>
  "expectation" in step ? `${step.expectation}:${step.type}` : step.type;

/** Advance until the pass proves the route; the steps taken, in order. */
const advanceUntilProven = async (
  route: CorpusIndexRoute = ROUTE,
): Promise<string[]> => {
  const steps: string[] = [];
  for (let page = 0; page < 50; page += 1) {
    // db-await-in-loop: each page's cursor is the one the previous page recorded
    const step = await advance(route);
    steps.push(stepName(step));
    if (step.type === "proven") {
      return steps;
    }
  }
  return panic(`The pass did not end: ${steps.join(", ")}`);
};

const readVerdict = async (options?: { maxAgeHours?: number }) =>
  await runInTransaction(
    async (tx) => await readCorpusIndexRouteProofsTx(tx, ROUTE, options),
  );

/** The judged status of one declared route. */
const statusOf = async (indexId: string = ROUTE.indexId) => {
  const verdict = await readVerdict();
  switch (verdict.type) {
    case "all_current": {
      const route =
        verdict.routes.find((proof) => proof.indexId === indexId) ??
        panic(`No proof of ${indexId}`);
      return { type: "current" as const, ...route };
    }
    case "not_ready":
      return (
        verdict.routes.find((reading) => reading.indexId === indexId) ??
        panic(`Undeclared route: ${indexId}`)
      ).status;
    default:
      return panic(`No route set: ${verdict.type}`);
  }
};

const passRow = async (indexId: string = ROUTE.indexId) =>
  (
    await db
      .select({
        passNumber: corpusIndexRouteProofs.passNumber,
        passExpectation: corpusIndexRouteProofs.passExpectation,
        passCursor: corpusIndexRouteProofs.passCursor,
        passInspected: corpusIndexRouteProofs.passInspected,
        passIndexIncarnation: corpusIndexRouteProofs.passIndexIncarnation,
      })
      .from(corpusIndexRouteProofs)
      .where(eq(corpusIndexRouteProofs.indexId, indexId))
  ).at(0) ?? panic(`The route ${indexId} has no proof row`);

const present = (incarnation: string) =>
  ({ type: "present", incarnation }) as const;

const enrolledGroupTarget = { manifest: MANIFEST, indexGroup: ENROLLED_GROUP };
const enrolledDigest =
  registeredCorpusIndexGroups(MANIFEST).find(
    ({ indexGroup }) => indexGroup === ENROLLED_GROUP,
  )?.effectiveDigest ?? panic("The enrolled group is not registered");

const attestEnrolled = async () => {
  await runInTransaction(async (tx) => {
    await bindCorpusIndexGroupEnrollmentTx(tx, enrolledGroupTarget);
    await attestCorpusIndexGroupEnrollmentTx(tx, {
      ...enrolledGroupTarget,
      effectiveDigest: enrolledDigest,
    });
  });
};

const withdrawEnrolled = async () =>
  await runInTransaction(
    async (tx) =>
      await withdrawCorpusIndexGroupEnrollmentTx(tx, {
        ...enrolledGroupTarget,
        actor: "service:route-proof-test",
        reason: "index rebuilt",
      }),
  );

const dropGeneration = async () => {
  await db.execute(
    sql.raw(
      `DELETE FROM corpus_index_projection_states WHERE generation = 'case_law_v10'`,
    ),
  );
  await db.execute(
    sql.raw(
      `DELETE FROM corpus_index_projection_intents WHERE generation = 'case_law_v10'`,
    ),
  );
  await db
    .delete(corpusIndexGenerations)
    .where(eq(corpusIndexGenerations.generation, ROUTE.generation));
};

const registerGeneration = async () => {
  await db.insert(corpusIndexGenerations).values({
    family: ROUTE.family,
    generation: ROUTE.generation,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(MANIFEST),
    status: "building",
  });
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.execute(
    sql.raw('TRUNCATE TABLE "corpus_index_generations" CASCADE'),
  );
  await registerGeneration();
  engine = new Map();
  orphans = new Map();
  incarnations = new Map(
    [ROUTE.indexId, ENROLLED.indexId].map((indexId) => [
      indexId,
      `${indexId}:01JFIRST`,
    ]),
  );
  reads = { census: 0, count: 0, incarnation: 0 };
  switchIncarnation = null;
  admitted = [];
});

describe("route readiness proof", () => {
  test("a clean pass walks the applied revisions, then the deleted ones, and proves the route on the incarnation it walked", async () => {
    for (const index of [0, 1, 2, 3, 4]) {
      // db-await-in-loop: a five-decision fixture
      await seedApplied(index);
    }
    await seedSettled(5);
    await seedWithdrawn(6);
    expect(await statusOf()).toEqual({ type: "never_proven" });

    const steps = await advanceUntilProven();
    expect(steps).toEqual([
      "present:advanced",
      "present:advanced",
      "present:phase_completed",
      // One settled and one withdrawn revision: one page ending on the
      // phase's last key.
      "absent:proven",
    ]);
    expect(await statusOf()).toMatchObject({
      type: "current",
      inspected: 7,
      incarnation: `${ROUTE.indexId}:01JFIRST`,
    });
    // The next pass starts on the same incarnation, at its beginning.
    expect(await passRow()).toMatchObject({
      passExpectation: "present",
      passCursor: null,
      passInspected: 0,
      passIndexIncarnation: `${ROUTE.indexId}:01JFIRST`,
    });
    // Every page went through the governor, one unit per page.
    expect(admitted).toEqual(
      steps.map(() => ({ step: "census", revisions: PAGE })),
    );
  });

  test("projection writes during a pass never restart it", async () => {
    for (const index of [0, 1, 2, 3, 4]) {
      // db-await-in-loop: a five-decision fixture
      await seedApplied(index);
    }
    expect((await advance()).type).toBe("advanced");
    const before = await passRow();
    const updatedAt = async () =>
      (
        await db
          .select({ updatedAt: corpusIndexRouteProofs.updatedAt })
          .from(corpusIndexRouteProofs)
      ).at(0);
    const rowBefore = await updatedAt();

    // Inflow: a new decision applied, a desired change queued.
    await seedApplied(9);
    await db
      .update(corpusIndexProjectionStates)
      .set({ desiredEpoch: 2n, desiredFingerprint: fingerprint(2) })
      .where(eq(corpusIndexProjectionStates.entityId, entityId(3)));

    expect(await updatedAt()).toEqual(rowBefore);
    expect(await passRow()).toEqual(before);
    const steps = await advanceUntilProven();
    expect(steps.at(-1)).toBe("absent:proven");
    expect((await statusOf()).type).toBe("current");
  });

  test("a revision applied behind the cursor reaches applied only on its own exact engine observation", async () => {
    for (const index of [2, 3, 4, 5]) {
      // db-await-in-loop: a four-decision fixture
      await seedApplied(index);
    }
    expect((await advance()).type).toBe("advanced");
    // Two decisions whose keys sort before every walked one, each committed
    // by an append and awaiting its proof.
    const lost = 0;
    const held = 1;
    for (const late of [lost, held]) {
      // db-await-in-loop: a two-decision fixture
      await db.insert(corpusIndexProjectionStates).values({
        family: ROUTE.family,
        generation: ROUTE.generation,
        entityId: entityId(late),
        desiredAction: "upsert",
        desiredEpoch: 1n,
        desiredFingerprint: fingerprint(1),
        desiredIndexId: ROUTE.indexId,
      });
      // db-await-in-loop: the intent of the state above
      await db.insert(corpusIndexProjectionIntents).values({
        id: revisionId(late),
        family: ROUTE.family,
        generation: ROUTE.generation,
        entityId: entityId(late),
        epoch: 1n,
        fingerprint: fingerprint(1),
        indexId: ROUTE.indexId,
        status: "append_committed",
        appendStartedAt: APPLIED_AT,
        appendCommittedAt: APPLIED_AT,
        appendPublishBarrierAt: APPLIED_AT,
        expectedDocumentCount: 3,
      });
    }
    const prove = async (late: number) => {
      const census = await proveCorpusProjectionRevisionsPresent({
        client: engineClient,
        indexId: ROUTE.indexId,
        expected: [{ revision: revisionId(late), documentCount: 3 }],
      });
      return await runInTransaction(
        async (tx) =>
          await proveAcceptedCorpusProjectionAppendsTx(tx, {
            indexId: ROUTE.indexId,
            census: census.isOk() ? census.value : panic("Census failed"),
            timing: { type: "after_barrier" },
          }),
      );
    };
    const appliedRevision = async (late: number) =>
      (
        await db
          .select({ revision: corpusIndexProjectionStates.appliedRevision })
          .from(corpusIndexProjectionStates)
          .where(eq(corpusIndexProjectionStates.entityId, entityId(late)))
      ).at(0)?.revision ?? null;

    // The engine lacks one's documents: the real prover does not apply it,
    // so the walked set never gains a revision the engine does not hold.
    await prove(lost);
    expect(await appliedRevision(lost)).toBeNull();
    // The engine holds the other's: applied, on its own exact count.
    engine.set(revisionId(held), { indexId: ROUTE.indexId, count: 3 });
    expect(await prove(held)).toEqual([
      {
        status: "applied",
        intentId: revisionId(held),
        entityId: entityId(held),
      },
    ]);
    expect(await appliedRevision(held)).toBe(revisionId(held));
    // The pass does not restart for it, and a later pass walks it.
    expect((await advanceUntilProven()).at(-1)).toBe("absent:proven");
    engine.delete(revisionId(held));
    expect(await advance()).toMatchObject({
      type: "drift_repaired",
      expectation: "present",
    });
  });

  test("a loss after its page was walked leaves the proof current until a later pass walks it", async () => {
    for (const index of [0, 1, 2, 3]) {
      // db-await-in-loop: a four-decision fixture
      await seedApplied(index);
    }
    expect((await advance()).type).toBe("advanced");
    // Lost behind the cursor: this pass cannot see it, by design.
    engine.delete(revisionId(0));
    expect((await advanceUntilProven()).at(-1)).toBe("absent:proven");
    expect((await statusOf()).type).toBe("current");
    // The next pass reads it and voids the proof.
    expect(await advance()).toMatchObject({
      type: "drift_repaired",
      expectation: "present",
      repaired: 1,
    });
    expect(await statusOf()).toEqual({
      type: "revoked",
      reason: "present_drift",
    });
  });

  test("an applied revision the engine lost is repaired and revokes the route's proof", async () => {
    for (const index of [0, 1, 2]) {
      // db-await-in-loop: a three-decision fixture
      await seedApplied(index);
    }
    await advanceUntilProven();
    engine.delete(revisionId(1));
    expect(await advance()).toEqual({
      type: "drift_repaired",
      expectation: "present",
      repaired: 1,
    });
    expect(admitted.at(-1)).toEqual({ step: "repair", revisions: 1 });
    expect(await statusOf()).toEqual({
      type: "revoked",
      reason: "present_drift",
    });
    const [repaired] = await db
      .select({ applied: corpusIndexProjectionStates.appliedRevision })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, entityId(1)));
    expect(repaired).toEqual({ applied: null });

    // Only a pass started after the repair proves the route again.
    await advanceUntilProven();
    expect(await statusOf()).toMatchObject({ type: "current", inspected: 2 });
  });

  test("a settled or withdrawn revision found in the engine is reopened and revokes the route's proof", async () => {
    await seedApplied(0);
    await seedSettled(1);
    await seedWithdrawn(2);
    await advanceUntilProven();

    engine.set(revisionId(2), { indexId: ROUTE.indexId, count: 3 });
    expect(await advance()).toMatchObject({
      type: "phase_completed",
      expectation: "present",
    });
    expect(await advance()).toMatchObject({
      type: "drift_repaired",
      expectation: "absent",
      repaired: 1,
    });
    expect(await statusOf()).toEqual({
      type: "revoked",
      reason: "absent_drift",
    });
    const [reopened] = await db
      .select({ status: corpusIndexProjectionIntents.status })
      .from(corpusIndexProjectionIntents)
      .where(eq(corpusIndexProjectionIntents.id, revisionId(2)));
    expect(reopened).toEqual({ status: "cleanup_pending" });
  });

  test("an empty route is proven only after the engine shows its index empty", async () => {
    orphans.set(ROUTE.indexId, 4);
    expect(await advance()).toEqual({
      type: "unknown_documents",
      documents: 4,
    });
    expect(await statusOf()).toEqual({ type: "never_proven" });

    orphans.delete(ROUTE.indexId);
    expect(await advanceUntilProven()).toEqual([
      "present:phase_completed",
      "absent:proven",
    ]);
    expect(reads).toMatchObject({ census: 0, count: 2 });
    expect(await statusOf()).toMatchObject({ type: "current", inspected: 0 });

    // A missing index proves nothing, and voids what a pass read of it.
    incarnations.delete(ROUTE.indexId);
    expect(await advance()).toEqual({ type: "index_missing" });
    expect(await statusOf()).toEqual({
      type: "revoked",
      reason: "index_replaced",
    });
  });

  test("an index recreated under the same id voids the proof, before a page and at the pass's end", async () => {
    const second = `${ROUTE.indexId}:01JSECOND`;
    const third = `${ROUTE.indexId}:01JTHIRD`;
    for (const index of [0, 1, 2]) {
      // db-await-in-loop: a three-decision fixture
      await seedApplied(index);
    }
    await advanceUntilProven();

    // Recreated before a page: that page revokes and walks the new index
    // from the start.
    incarnations.set(ROUTE.indexId, second);
    expect((await advance()).type).toBe("advanced");
    expect(await statusOf()).toEqual({
      type: "revoked",
      reason: "index_replaced",
    });
    expect((await passRow()).passIndexIncarnation).toBe(second);
    expect((await advance()).type).toBe("phase_completed");

    // Recreated between the pass's last census read and its end: the end
    // reads another incarnation, so nothing is proven, and the next page
    // revokes and starts over.
    switchIncarnation = {
      atRead: reads.incarnation + 2,
      indexId: ROUTE.indexId,
      to: third,
    };
    expect(await advance()).toMatchObject({ type: "superseded" });
    expect((await advance()).type).toBe("advanced");
    expect(await statusOf()).toEqual({
      type: "revoked",
      reason: "index_replaced",
    });
    await advanceUntilProven();
    expect(await statusOf()).toMatchObject({
      type: "current",
      incarnation: third,
    });
  });

  test("only a declared, attested route can be walked, and its attestation bounds its proof", async () => {
    expect(await advance({ ...ROUTE, indexId: "case_law_v10_xyz" })).toEqual({
      type: "refused",
      refusal: { type: "undeclared_route" },
    });
    expect(await advance(ENROLLED)).toEqual({
      type: "refused",
      refusal: { type: "unattested", reason: "unbound" },
    });
    expect(await statusOf(ENROLLED.indexId)).toEqual({
      type: "unattested",
      reason: "unbound",
    });
    expect(reads.census + reads.count).toBe(0);

    await attestEnrolled();
    await seedApplied(0, ENROLLED.indexId);
    await advanceUntilProven(ENROLLED);
    expect((await statusOf(ENROLLED.indexId)).type).toBe("current");

    // Withdrawal revokes in its own transaction; a pass cannot continue.
    expect(await withdrawEnrolled()).toBe(true);
    expect(await statusOf(ENROLLED.indexId)).toEqual({
      type: "unattested",
      reason: "pending",
    });
    expect(await advance(ENROLLED)).toEqual({
      type: "refused",
      refusal: { type: "unattested", reason: "pending" },
    });

    // A new attestation does not bring the old proof back: the route needs a
    // pass started after it.
    await attestEnrolled();
    expect(await statusOf(ENROLLED.indexId)).toEqual({
      type: "revoked",
      reason: "group_attested",
    });
    await advanceUntilProven(ENROLLED);
    expect((await statusOf(ENROLLED.indexId)).type).toBe("current");
  });

  test("a page read before a withdrawal is not recorded after it", async () => {
    await attestEnrolled();
    await seedApplied(0, ENROLLED.indexId);
    const incarnation = `${ENROLLED.indexId}:01JFIRST`;
    const started = await runInTransaction(
      async (tx) =>
        await startCorpusIndexRouteCensusPageTx(
          tx,
          ENROLLED,
          present(incarnation),
        ),
    );
    const pass = started.type === "pass" ? started.pass : panic("No pass");
    await withdrawEnrolled();
    await attestEnrolled();
    expect(
      await runInTransaction(
        async (tx) =>
          await recordCorpusIndexRouteCensusPageTx(tx, {
            route: ENROLLED,
            pass,
            incarnation,
            inspected: 1,
            nextCursor: null,
            complete: true,
          }),
      ),
    ).toEqual({ type: "superseded" });
  });

  test("the generation is all current only when every declared route is, and the flip re-reads each incarnation", async () => {
    const verdict = await readVerdict();
    if (verdict.type !== "not_ready") {
      return panic(`Expected not ready, got ${verdict.type}`);
    }
    // Every declared route is listed, though none has a row.
    expect(verdict.routes.length).toBeGreaterThan(1);
    expect(
      verdict.routes.every(({ status }) =>
        ["never_proven", "unattested"].includes(status.type),
      ),
    ).toBe(true);

    for (const group of registeredCorpusIndexGroups(MANIFEST)) {
      // db-await-in-loop: one attestation per registered group
      await runInTransaction(async (tx) => {
        await bindCorpusIndexGroupEnrollmentTx(tx, {
          manifest: MANIFEST,
          indexGroup: group.indexGroup,
        });
        await attestCorpusIndexGroupEnrollmentTx(tx, {
          manifest: MANIFEST,
          indexGroup: group.indexGroup,
          effectiveDigest: group.effectiveDigest,
        });
      });
    }
    for (const { indexId } of verdict.routes) {
      incarnations.set(indexId, `${indexId}:01JFIRST`);
      // db-await-in-loop: one short pass per declared route
      await advanceUntilProven({ ...ROUTE, indexId });
    }
    // A stray row of a route the manifest does not declare proves nothing.
    await runInTransaction(
      async (tx) =>
        await revokeCorpusIndexRouteProofTx(
          tx,
          { ...ROUTE, indexId: "case_law_v10_xyz" },
          "present_drift",
        ),
    );
    const ready = await readVerdict();
    if (ready.type !== "all_current") {
      return panic(`Expected all current, got ${ready.type}`);
    }
    expect(ready.routes.map(({ indexId }) => indexId)).toEqual(
      verdict.routes.map(({ indexId }) => indexId),
    );
    expect(ready.undeclared).toEqual(["case_law_v10_xyz"]);
    const check = async () =>
      await checkCorpusIndexRouteProofIncarnations({
        client: engineClient,
        proofs: ready,
      });
    expect((await check()).unwrap()).toEqual({ type: "held" });
    incarnations.set(ROUTE.indexId, `${ROUTE.indexId}:01JSECOND`);
    expect((await check()).unwrap()).toEqual({
      type: "replaced",
      indexIds: [ROUTE.indexId],
    });
    // A tighter bound than the proof's own is the reader's choice.
    expect((await readVerdict({ maxAgeHours: 1 })).type).toBe("all_current");
  });

  test("a page read across a revocation, or by a second runner, is not recorded", async () => {
    await seedApplied(0);
    const incarnation = `${ROUTE.indexId}:01JFIRST`;
    const start = async () => {
      const started = await runInTransaction(
        async (tx) =>
          await startCorpusIndexRouteCensusPageTx(
            tx,
            ROUTE,
            present(incarnation),
          ),
      );
      return started.type === "pass" ? started.pass : panic("No pass");
    };
    const pass = await start();
    const record = async (
      recorded: typeof pass,
      complete: boolean,
      at: string = incarnation,
    ) =>
      await runInTransaction(
        async (tx) =>
          await recordCorpusIndexRouteCensusPageTx(tx, {
            route: ROUTE,
            pass: recorded,
            incarnation: at,
            inspected: 1,
            nextCursor: complete ? null : entityId(0),
            complete,
          }),
      );
    // Two runners read the same pass: the first records, the second is late.
    expect(await record(pass, false)).toEqual({ type: "advanced" });
    expect(await record(pass, false)).toEqual({ type: "superseded" });

    await runInTransaction(
      async (tx) =>
        await revokeCorpusIndexRouteProofTx(tx, ROUTE, "present_drift"),
    );
    const fresh = await start();
    expect(fresh).toMatchObject({ expectation: "present", cursor: null });
    // Read on another incarnation than the pass is bound to.
    expect(await record(fresh, false, `${ROUTE.indexId}:01JOTHER`)).toEqual({
      type: "superseded",
    });
    await runInTransaction(
      async (tx) =>
        await revokeCorpusIndexRouteProofTx(tx, ROUTE, "present_drift"),
    );
    expect(await record(fresh, true)).toEqual({ type: "superseded" });
    expect(await passRow()).toMatchObject({
      passExpectation: "present",
      passCursor: null,
      passInspected: 0,
    });
  });

  test("a proof expires counted from the start of its pass, not its end", async () => {
    await seedApplied(0);
    await advanceUntilProven();
    // A pass that took 25 hours ended a minute ago.
    await db
      .update(corpusIndexRouteProofs)
      .set({
        provenPassStartedAt: sql`proven_pass_started_at - INTERVAL '25 hours'`,
      })
      .where(eq(corpusIndexRouteProofs.indexId, ROUTE.indexId));
    expect((await statusOf()).type).toBe("expired");
  });

  test("a revocation before the route's first pass is kept, so only a pass started after it proves the route", async () => {
    await seedApplied(0);
    await runInTransaction(
      async (tx) =>
        await revokeCorpusIndexRouteProofTx(tx, ROUTE, "present_drift"),
    );
    expect(await statusOf()).toEqual({ type: "never_proven" });
    expect(await passRow()).toMatchObject({
      passNumber: 1,
      passIndexIncarnation: null,
    });
    await advanceUntilProven();
    expect((await statusOf()).type).toBe("current");
  });

  test("a rebuilt generation keeps no proof, and a page read before it never lands on the new one", async () => {
    await seedApplied(0);
    const started = await runInTransaction(
      async (tx) =>
        await startCorpusIndexRouteCensusPageTx(
          tx,
          ROUTE,
          present(`${ROUTE.indexId}:01JFIRST`),
        ),
    );
    const stale = started.type === "pass" ? started.pass : panic("No pass");
    await dropGeneration();
    expect(await db.select().from(corpusIndexRouteProofs)).toEqual([]);
    await registerGeneration();
    const restarted = await runInTransaction(
      async (tx) =>
        await startCorpusIndexRouteCensusPageTx(
          tx,
          ROUTE,
          present(`${ROUTE.indexId}:01JFIRST`),
        ),
    );
    const fresh = restarted.type === "pass" ? restarted.pass : panic("No pass");
    // Same number, same phase, same cursor: only the pass id tells them apart.
    expect(fresh).toMatchObject({
      number: stale.number,
      expectation: stale.expectation,
      cursor: stale.cursor,
    });
    expect(fresh.id).not.toBe(stale.id);
    expect(
      await runInTransaction(
        async (tx) =>
          await recordCorpusIndexRouteCensusPageTx(tx, {
            route: ROUTE,
            pass: stale,
            incarnation: `${ROUTE.indexId}:01JFIRST`,
            inspected: 1,
            nextCursor: null,
            complete: true,
          }),
      ),
    ).toEqual({ type: "superseded" });
  });

  test("a pass ends while inflow keeps adding keys after its cursor", async () => {
    for (const index of [0, 1, 2]) {
      // db-await-in-loop: a three-decision fixture
      await seedApplied(index);
    }
    const steps: string[] = [];
    for (let page = 0; page < 20; page += 1) {
      // db-await-in-loop: each page reads the cursor the previous one recorded
      const step = await advance();
      steps.push(stepName(step));
      if (step.type === "proven") {
        break;
      }
      // Every page, a decision applied with a key larger than any walked.
      // db-await-in-loop: one new decision per page
      await seedApplied(100 + page);
    }
    // The phase walks only what existed when it began: two pages of two.
    expect(steps).toEqual([
      "present:advanced",
      "present:phase_completed",
      "absent:proven",
    ]);
  });

  test("one page costs one census read and one incarnation read, and the pass's end one more", async () => {
    for (const index of [0, 1, 2, 3, 4, 5]) {
      // db-await-in-loop: a six-decision fixture
      await seedApplied(index);
    }
    expect(await advanceUntilProven()).toEqual([
      "present:advanced",
      "present:advanced",
      "present:phase_completed",
      "absent:proven",
    ]);
    // Six applied revisions in pages of two, the last page ending on the
    // phase's last key; an empty absent phase reads no census.
    expect(reads).toEqual({ census: 3, count: 0, incarnation: 5 });
  });
});
