/**
 * A route's readiness proof against a real PostgreSQL schema and a fake
 * engine that answers the census aggregation from a map: a clean pass proves
 * the route, projection writes during a pass never restart it, drift found by
 * a page is repaired and revokes the proof in the repair's transaction, and a
 * page read across a revocation or by a second runner is never recorded.
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
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  advanceCorpusIndexRouteProof,
  type CorpusIndexRouteProofAdvance,
} from "@/api/lib/legal-search/corpus-index-route-proof";
import {
  type CorpusIndexRoute,
  ensureCorpusIndexRouteCensusPassTx,
  readCorpusIndexRouteProofsTx,
  recordCorpusIndexRouteCensusPageTx,
  revokeCorpusIndexRouteProofTx,
} from "@/api/lib/legal-search/corpus-index-route-proof-store";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const ROUTE = {
  family: "case_law",
  generation: "case_law_v10",
  indexId: "case_law_v10_cze",
} as const satisfies CorpusIndexRoute;

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

/** What the fake engine holds: projection revision to document count. */
let engine: Map<string, number>;
let censusReads: number;

const PROJECTION_REVISION_TERM = /projection_revision:"(?<revision>[^"]+)"/gu;

const engineClient = {
  aggregate: async ({ query }: { indexId: string; query: string }) => {
    censusReads += 1;
    const buckets = [...query.matchAll(PROJECTION_REVISION_TERM)].flatMap(
      ({ groups }) => {
        const revision = groups?.["revision"];
        const count = revision === undefined ? undefined : engine.get(revision);
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
};

const runInTransaction = async <T>(
  work: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  await db.transaction(async (tx) => await work(asTestRaw<Transaction>(tx)));

/** One decision the projection applied to the route, held by the engine. */
const seedApplied = async (index: number) => {
  const revision = revisionId(index);
  await db.insert(corpusIndexProjectionIntents).values({
    id: revision,
    family: ROUTE.family,
    generation: ROUTE.generation,
    entityId: entityId(index),
    epoch: 1n,
    fingerprint: fingerprint(1),
    indexId: ROUTE.indexId,
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
    desiredIndexId: ROUTE.indexId,
    appliedAction: "upsert",
    appliedEpoch: 1n,
    appliedRevision: revision,
    appliedFingerprint: fingerprint(1),
    appliedIndexId: ROUTE.indexId,
    appliedAt: APPLIED_AT,
  });
  engine.set(revision, 3);
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

const advance = async (): Promise<CorpusIndexRouteProofAdvance> => {
  const advanced = await advanceCorpusIndexRouteProof({
    runInTransaction,
    client: engineClient,
    route: ROUTE,
    limit: PAGE,
  });
  return Result.isOk(advanced)
    ? advanced.value
    : panic(`Route census failed: ${advanced.error.message}`);
};

/** Advance until the pass proves the route; the steps taken, in order. */
const advanceUntilProven = async (): Promise<string[]> => {
  const steps: string[] = [];
  for (let page = 0; page < 50; page += 1) {
    // db-await-in-loop: each page's cursor is the one the previous page recorded
    const step = await advance();
    steps.push(`${step.expectation}:${step.type}`);
    if (step.type === "proven") {
      return steps;
    }
  }
  return panic(`The pass did not end: ${steps.join(", ")}`);
};

const readProof = async () =>
  (
    await runInTransaction(
      async (tx) => await readCorpusIndexRouteProofsTx(tx, ROUTE),
    )
  ).at(0) ?? panic("The route has no proof row");

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
  await db.insert(corpusIndexGenerations).values({
    family: ROUTE.family,
    generation: ROUTE.generation,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v10,
    ),
    status: "building",
  });
  engine = new Map();
  censusReads = 0;
});

describe("route readiness proof", () => {
  test("a clean pass walks the applied revisions, then the deleted ones, and proves the route", async () => {
    for (const index of [0, 1, 2, 3, 4]) {
      // db-await-in-loop: a five-decision fixture
      await seedApplied(index);
    }
    await seedSettled(5);
    expect(
      await runInTransaction(
        async (tx) => await readCorpusIndexRouteProofsTx(tx, ROUTE),
      ),
    ).toEqual([]);

    const steps = await advanceUntilProven();
    expect(steps).toEqual([
      "present:advanced",
      "present:advanced",
      "present:phase_completed",
      "absent:proven",
    ]);
    const proof = await readProof();
    expect(proof.status).toMatchObject({ type: "current", inspected: 6 });
    // The next pass starts the instant this one proved the route.
    expect(proof.pass).toMatchObject({
      expectation: "present",
      cursor: null,
      inspected: 0,
    });
    expect(
      proof.status.type === "current" ? proof.status.provenAtUs : null,
    ).toBe(proof.pass.startedAtUs);
  });

  test("projection writes during a pass never restart it", async () => {
    for (const index of [0, 1, 2, 3, 4]) {
      // db-await-in-loop: a five-decision fixture
      await seedApplied(index);
    }
    expect((await advance()).type).toBe("advanced");
    const before = await readProof();
    const proofRowBefore = (
      await db
        .select({ updatedAt: corpusIndexRouteProofs.updatedAt })
        .from(corpusIndexRouteProofs)
    ).at(0);

    // Inflow: a new decision applied, a desired change queued, a state
    // rewritten. Every one bumps the generation's projection revision.
    await seedApplied(9);
    await db
      .update(corpusIndexProjectionStates)
      .set({ desiredEpoch: 2n, desiredFingerprint: fingerprint(2) })
      .where(eq(corpusIndexProjectionStates.entityId, entityId(3)));

    const proofRowAfter = (
      await db
        .select({ updatedAt: corpusIndexRouteProofs.updatedAt })
        .from(corpusIndexRouteProofs)
    ).at(0);
    expect(proofRowAfter).toEqual(proofRowBefore);
    expect((await readProof()).pass).toEqual(before.pass);

    const steps = await advanceUntilProven();
    // The pass resumed where it was: no step went back to the start.
    expect(steps.at(-1)).toBe("absent:proven");
    expect((await readProof()).status.type).toBe("current");
  });

  test("an applied revision the engine lost is repaired and revokes the route's proof", async () => {
    for (const index of [0, 1, 2]) {
      // db-await-in-loop: a three-decision fixture
      await seedApplied(index);
    }
    await advanceUntilProven();
    expect((await readProof()).status.type).toBe("current");

    engine.delete(revisionId(1));
    const drift = await advance();
    expect(drift).toEqual({
      type: "drift_repaired",
      expectation: "present",
      repaired: 1,
    });
    const revoked = await readProof();
    expect(revoked.status).toEqual({
      type: "revoked",
      reason: "present_drift",
    });
    expect(revoked.pass).toMatchObject({
      expectation: "present",
      cursor: null,
    });
    // The repair unnamed the lost copy: the decision waits for a re-append.
    const [repaired] = await db
      .select({ applied: corpusIndexProjectionStates.appliedRevision })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, entityId(1)));
    expect(repaired).toEqual({ applied: null });

    // Only a pass started after the repair proves the route again.
    await advanceUntilProven();
    const reproven = await readProof();
    expect(reproven.status).toMatchObject({ type: "current", inspected: 2 });
  });

  test("a deleted revision found in the engine is reopened and revokes the route's proof", async () => {
    await seedApplied(0);
    await seedSettled(1);
    await advanceUntilProven();

    engine.set(revisionId(1), 3);
    expect(await advance()).toMatchObject({
      type: "phase_completed",
      expectation: "present",
    });
    expect(await advance()).toMatchObject({
      type: "drift_repaired",
      expectation: "absent",
      repaired: 1,
    });
    expect((await readProof()).status).toEqual({
      type: "revoked",
      reason: "absent_drift",
    });
    const [reopened] = await db
      .select({ status: corpusIndexProjectionIntents.status })
      .from(corpusIndexProjectionIntents)
      .where(eq(corpusIndexProjectionIntents.id, revisionId(1)));
    expect(reopened).toEqual({ status: "cleanup_pending" });
  });

  test("a page read across a revocation, or by a second runner, is not recorded", async () => {
    await seedApplied(0);
    const pass = await runInTransaction(
      async (tx) => await ensureCorpusIndexRouteCensusPassTx(tx, ROUTE),
    );
    const record = async () =>
      await runInTransaction(
        async (tx) =>
          await recordCorpusIndexRouteCensusPageTx(tx, {
            route: ROUTE,
            pass,
            inspected: 1,
            nextCursor: entityId(0),
            complete: false,
          }),
      );
    // Two runners read the same pass: the first records, the second is late.
    expect(await record()).toEqual({ type: "advanced" });
    expect(await record()).toEqual({ type: "superseded" });

    // A pass at its start, so the revocation below changes nothing but the
    // pass's start: phase and cursor read the same before and after it.
    await runInTransaction(
      async (tx) =>
        await revokeCorpusIndexRouteProofTx(tx, ROUTE, "present_drift"),
    );
    const fresh = await runInTransaction(
      async (tx) => await ensureCorpusIndexRouteCensusPassTx(tx, ROUTE),
    );
    expect(fresh).toMatchObject({ expectation: "present", cursor: null });
    await runInTransaction(
      async (tx) =>
        await revokeCorpusIndexRouteProofTx(tx, ROUTE, "present_drift"),
    );
    const afterRevoke = await runInTransaction(
      async (tx) =>
        await recordCorpusIndexRouteCensusPageTx(tx, {
          route: ROUTE,
          pass: fresh,
          inspected: 1,
          nextCursor: null,
          complete: true,
        }),
    );
    expect(afterRevoke).toEqual({ type: "superseded" });
    expect((await readProof()).pass).toMatchObject({
      expectation: "present",
      cursor: null,
      inspected: 0,
    });
  });

  test("a proof older than its maximum age no longer counts", async () => {
    await seedApplied(0);
    await advanceUntilProven();
    await db
      .update(corpusIndexRouteProofs)
      .set({
        provenPassStartedAt: sql`proven_pass_started_at - INTERVAL '25 hours'`,
        provenAt: sql`proven_at - INTERVAL '25 hours'`,
      })
      .where(eq(corpusIndexRouteProofs.indexId, ROUTE.indexId));
    expect((await readProof()).status.type).toBe("expired");
  });

  test("a route never walked has nothing to revoke, and a rebuilt generation keeps no proof", async () => {
    await runInTransaction(
      async (tx) =>
        await revokeCorpusIndexRouteProofTx(tx, ROUTE, "present_drift"),
    );
    expect(
      await runInTransaction(
        async (tx) => await readCorpusIndexRouteProofsTx(tx, ROUTE),
      ),
    ).toEqual([]);

    await seedApplied(0);
    await advanceUntilProven();
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
    expect(await db.select().from(corpusIndexRouteProofs)).toEqual([]);
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
      steps.push(`${step.expectation}:${step.type}`);
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

  test("a page read before a rebuild never lands on the re-registered generation's proof", async () => {
    await seedApplied(0);
    const stale = await runInTransaction(
      async (tx) => await ensureCorpusIndexRouteCensusPassTx(tx, ROUTE),
    );
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
    await db.insert(corpusIndexGenerations).values({
      family: ROUTE.family,
      generation: ROUTE.generation,
      cluster: "q09",
      manifestDigest: corpusIndexManifestDigest(
        CORPUS_INDEX_MANIFESTS.case_law_v10,
      ),
      status: "building",
    });
    const fresh = await runInTransaction(
      async (tx) => await ensureCorpusIndexRouteCensusPassTx(tx, ROUTE),
    );
    // Same number, same phase, same cursor: only the pass token tells them apart.
    expect(fresh).toMatchObject({
      number: stale.number,
      expectation: stale.expectation,
      cursor: stale.cursor,
    });
    expect(fresh.token).not.toBe(stale.token);
    expect(
      await runInTransaction(
        async (tx) =>
          await recordCorpusIndexRouteCensusPageTx(tx, {
            route: ROUTE,
            pass: stale,
            inspected: 1,
            nextCursor: null,
            complete: true,
          }),
      ),
    ).toEqual({ type: "superseded" });
  });

  test("one page costs one census read and no more", async () => {
    for (const index of [0, 1, 2, 3, 4, 5]) {
      // db-await-in-loop: a six-decision fixture
      await seedApplied(index);
    }
    await advanceUntilProven();
    // Six applied revisions in pages of two, plus an empty absent phase.
    expect(censusReads).toBe(3);
  });
});
