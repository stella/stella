/**
 * A route's readiness proof against a real PostgreSQL schema and a fake
 * engine that answers the census aggregation, the document count and the
 * index incarnation from maps: a clean pass proves the route on the
 * incarnation it walked, projection writes during a pass never restart it,
 * drift found by a page is repaired and revokes the proof in the repair's
 * transaction, a page read across a revocation or by a second runner is never
 * recorded, an open pass too old to prove is started over while a young one
 * is resumed, and only declared, attested routes can be walked at all. A
 * pass split into key ranges proves exactly what one cursor does, each key
 * walked once; a range on another incarnation, a revocation, or an age taken
 * from its earliest range applies to every range of the pass.
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

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  corpusIndexRouteProofs,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
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
  CORPUS_INDEX_ROUTE_CENSUS_PAGE_MAX,
  CORPUS_INDEX_ROUTE_CENSUS_PAGE_MIN,
  type CorpusIndexRouteCensusPageSize,
  type CorpusIndexRouteProofAdmission,
  type CorpusIndexRouteProofAdvance,
  type CorpusIndexRouteProofPage,
  type CorpusIndexRouteProofWorkUnit,
  initialCorpusIndexRouteCensusPageSize,
  isCorpusIndexReadTimeout,
  nextCorpusIndexRouteCensusPageSize,
} from "@/api/lib/legal-search/corpus-index-route-proof";
import { CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS } from "@/api/lib/legal-search/corpus-index-route-proof-contract";
import {
  checkCorpusIndexRouteProofIncarnations,
  type CorpusIndexGenerationRouteProofs,
  type CorpusIndexRoute,
  readCorpusIndexRouteProofsTx,
  recordCorpusIndexRouteCensusPageTx,
  revokeCorpusIndexRouteProofTx,
  startCorpusIndexRouteCensusPageTx,
} from "@/api/lib/legal-search/corpus-index-route-proof-store";
import {
  resetLogSinkForTesting,
  setLogSinkForTesting,
} from "@/api/lib/observability/logger";
import { isRecord } from "@/api/lib/type-guards";
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
/** Every revision a census read asked the engine for, in order. */
let asked: string[];
/** A census naming more revisions than this times out, as the engine would. */
let censusTimesOutAbove: number | null;
let admitted: CorpusIndexRouteProofWorkUnit[];

const PROJECTION_REVISION_TERM = /projection_revision:"(?<revision>[^"]+)"/gu;

const engineClient = {
  aggregate: async ({ query }: { indexId: string; query: string }) => {
    reads.census += 1;
    const terms = [...query.matchAll(PROJECTION_REVISION_TERM)];
    if (censusTimesOutAbove !== null && terms.length > censusTimesOutAbove) {
      const timedOut = new Error("The operation timed out.");
      timedOut.name = "TimeoutError";
      return Result.err(
        new CorpusIndexError({
          message: "corpus index POST search failed within its budget",
          cause: timedOut,
          reach: "unreachable",
        }),
      );
    }
    asked.push(...terms.map(({ groups }) => groups?.["revision"] ?? ""));
    const buckets = terms.flatMap(({ groups }) => {
      const revision = groups?.["revision"];
      const count =
        revision === undefined ? undefined : engine.get(revision)?.count;
      return count === undefined || count === 0
        ? []
        : [{ key: revision, doc_count: count }];
    });
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
      switchIncarnation?.indexId === indexId &&
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

/** A governor that admits at once and records each unit it was asked for. */
const governor: CorpusIndexRouteProofAdmission = async (unit, work) => {
  admitted.push(unit);
  return await work();
};

const advancePage = async (
  route: CorpusIndexRoute = ROUTE,
  { range = 0, ranges = 1, limit = PAGE } = {},
): Promise<CorpusIndexRouteProofPage> => {
  const advanced = await advanceCorpusIndexRouteProof({
    runInTransaction,
    client: engineClient,
    admit: governor,
    route,
    range,
    ranges,
    limit,
  });
  return Result.isOk(advanced)
    ? advanced.value
    : panic(`Route census failed: ${advanced.error.message}`);
};

const advance = async (
  route: CorpusIndexRoute = ROUTE,
): Promise<CorpusIndexRouteProofAdvance> => (await advancePage(route)).advance;

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

/** An interval of `hours` hours, to move a fixture's clock columns back. */
const hoursInterval = (hours: number) =>
  sql`make_interval(secs => ${Math.round(hours * 3600)})`;

/** Hours past the maximum age: a pass started this long ago proves nothing. */
const PAST_MAX_AGE_HOURS = CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS + 1;

/** The judged status of one declared route. */
const statusOf = async (
  indexId: string = ROUTE.indexId,
  options?: { maxAgeHours?: number },
) => {
  const verdict = await readVerdict(options);
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
    case "generation_absent":
    case "open_route_set":
      return panic(`No route set: ${verdict.type}`);
    default:
      verdict satisfies never;
      return panic("Unhandled route proof verdict");
  }
};

const notReadyVerdict = (verdict: CorpusIndexGenerationRouteProofs) =>
  verdict.type === "not_ready"
    ? verdict
    : panic(`Expected not ready, got ${verdict.type}`);

const allCurrentVerdict = (verdict: CorpusIndexGenerationRouteProofs) =>
  verdict.type === "all_current"
    ? verdict
    : panic(`Expected all current, got ${verdict.type}`);

/** The ranges the row holds for its pass under way; none before they are laid out. */
const rangesOfRow = ({
  passId,
  passRanges,
}: {
  passId: string;
  passRanges: unknown;
}): Record<string, unknown>[] =>
  isRecord(passRanges) &&
  passRanges["passId"] === passId &&
  Array.isArray(passRanges["ranges"])
    ? passRanges["ranges"].filter(isRecord)
    : [];

const routePass = async (indexId: string = ROUTE.indexId) => {
  const row =
    (
      await db
        .select({
          passNumber: corpusIndexRouteProofs.passNumber,
          passId: corpusIndexRouteProofs.passId,
          passRanges: corpusIndexRouteProofs.passRanges,
          passIndexIncarnation: corpusIndexRouteProofs.passIndexIncarnation,
        })
        .from(corpusIndexRouteProofs)
        .where(eq(corpusIndexRouteProofs.indexId, indexId))
    ).at(0) ?? panic(`The route ${indexId} has no proof row`);
  return { ...row, ranges: rangesOfRow(row) };
};

/**
 * The route's pass and where its first range stands: at its beginning before
 * the pass's first page lays the ranges out.
 */
const passRow = async (indexId: string = ROUTE.indexId) => {
  const { passNumber, passIndexIncarnation, ranges } = await routePass(indexId);
  const first = ranges.at(0);
  return {
    passNumber,
    passExpectation: first?.["expectation"] ?? "present",
    passCursor: first?.["cursor"] ?? null,
    passInspected: first?.["inspected"] ?? 0,
    passIndexIncarnation,
  };
};

/**
 * Move the route's pass back `hours` on the database clock: the instant it
 * was begun and the start of every range, or with `ranges` the start of
 * those ranges alone.
 */
const agePass = async (
  hours: number,
  { ranges }: { ranges?: readonly number[] } = {},
) => {
  const moved =
    ranges === undefined
      ? sql`true`
      : sql`(laid.position - 1) = ANY(${sql.raw(`ARRAY[${ranges.map(String).join(",") || "-1"}]::bigint[]`)})`;
  await db.execute(sql`
    UPDATE corpus_index_route_proofs
    SET pass_started_at = ${
      ranges === undefined
        ? sql`pass_started_at - ${hoursInterval(hours)}`
        : sql`pass_started_at`
    },
      pass_ranges = CASE WHEN pass_ranges IS NULL THEN NULL ELSE jsonb_set(
        pass_ranges,
        '{ranges}',
        (
          SELECT jsonb_agg(
            CASE WHEN ${moved}
              THEN laid.value || jsonb_build_object(
                'startedAt',
                (laid.value ->> 'startedAt')::timestamptz - ${hoursInterval(hours)}
              )
              ELSE laid.value
            END
            ORDER BY laid.position
          )
          FROM jsonb_array_elements(pass_ranges -> 'ranges')
            WITH ORDINALITY AS laid(value, position)
        )
      ) END
    WHERE index_id = ${ROUTE.indexId}
  `);
};

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
  asked = [];
  censusTimesOutAbove = null;
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
    const { pass, range } =
      started.type === "pass" ? started : panic("No pass");
    await withdrawEnrolled();
    await attestEnrolled();
    expect(
      await runInTransaction(
        async (tx) =>
          await recordCorpusIndexRouteCensusPageTx(tx, {
            route: ENROLLED,
            pass,
            range,
            incarnation,
            inspected: 1,
            nextCursor: null,
            complete: true,
          }),
      ),
    ).toEqual({ type: "superseded" });
  });

  test("the generation is all current only when every declared route is, and the flip re-reads each incarnation", async () => {
    const verdict = notReadyVerdict(await readVerdict());
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
    const ready = allCurrentVerdict(await readVerdict());
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
      return started.type === "pass" ? started : panic("No pass");
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
            pass: recorded.pass,
            range: recorded.range,
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
    expect(fresh.range).toMatchObject({ expectation: "present", cursor: null });
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
    // A pass that took this many hours ended a moment ago.
    const passTook = async (hours: number) =>
      await db
        .update(corpusIndexRouteProofs)
        .set({
          provenPassStartedAt: sql`clock_timestamp() - ${hoursInterval(hours)}`,
        })
        .where(eq(corpusIndexRouteProofs.indexId, ROUTE.indexId));
    await passTook(CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS - 0.1);
    expect((await statusOf()).type).toBe("current");
    // A reader may tighten the bound below the proof's age.
    expect(
      (
        await statusOf(ROUTE.indexId, {
          maxAgeHours: CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS - 1,
        })
      ).type,
    ).toBe("expired");
    await passTook(CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS + 0.1);
    expect((await statusOf()).type).toBe("expired");
  });

  test("a reader may never loosen the bound past the maximum age", async () => {
    await seedApplied(0);
    await advanceUntilProven();
    expect(
      (
        await statusOf(ROUTE.indexId, {
          maxAgeHours: CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS,
        })
      ).type,
    ).toBe("current");
    for (const maxAgeHours of [
      CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS + 0.1,
      0,
      Number.POSITIVE_INFINITY,
    ]) {
      // db-await-in-loop: each bound is refused before any query runs
      expect(await rejectionOf(readVerdict({ maxAgeHours }))).toMatchObject({
        message: expect.stringContaining("Route proof age outside its bound"),
      });
    }
  });

  test("an open pass too old to prove is started over without revoking, and the pass that follows proves the route fresh", async () => {
    for (const index of [0, 1, 2, 3, 4]) {
      // db-await-in-loop: a five-decision fixture
      await seedApplied(index);
    }
    await advanceUntilProven();
    // The next pass walked one page, then nothing picked it up for longer
    // than the maximum age.
    expect((await advance()).type).toBe("advanced");
    await agePass(PAST_MAX_AGE_HOURS);
    await db
      .update(corpusIndexRouteProofs)
      .set({
        provenPassStartedAt: sql`proven_pass_started_at - ${hoursInterval(PAST_MAX_AGE_HOURS)}`,
      })
      .where(eq(corpusIndexRouteProofs.indexId, ROUTE.indexId));
    expect((await statusOf()).type).toBe("expired");

    const restarts: Record<string, unknown>[] = [];
    setLogSinkForTesting(({ message, attributes }) => {
      if (message === "corpus_index.route_proof_pass_restarted") {
        restarts.push({ ...attributes });
      }
    });
    try {
      // The page that picks the pass up walks the first page of a new pass,
      // not the second page of the old one.
      expect(stepName(await advance())).toBe("present:advanced");
      expect(await passRow()).toMatchObject({
        passNumber: 3,
        passExpectation: "present",
        passCursor: entityId(1),
        passInspected: 2,
      });
      expect(restarts).toEqual([
        expect.objectContaining({
          index: ROUTE.indexId,
          reason: "pass_too_old_to_prove",
          passNumber: 3,
          abandonedPassNumber: 2,
          abandonedPassRows: 2,
          abandonedPassAgeHours: PAST_MAX_AGE_HOURS,
        }),
      ]);
      // A restart is not a revocation: the old proof still reads expired.
      expect((await statusOf()).type).toBe("expired");

      await advanceUntilProven();
      // Resumed from here on: one restart, not one per page.
      expect(restarts).toHaveLength(1);
    } finally {
      resetLogSinkForTesting();
    }
    expect(await statusOf()).toMatchObject({ type: "current", inspected: 5 });
    expect(
      await db
        .select({
          provenPassNumber: corpusIndexRouteProofs.provenPassNumber,
          revokedAt: corpusIndexRouteProofs.revokedAt,
        })
        .from(corpusIndexRouteProofs)
        .where(eq(corpusIndexRouteProofs.indexId, ROUTE.indexId)),
    ).toEqual([{ provenPassNumber: 3, revokedAt: null }]);
  });

  test("a young open pass is resumed where it stopped, on the same pass", async () => {
    for (const index of [0, 1, 2, 3, 4]) {
      // db-await-in-loop: a five-decision fixture
      await seedApplied(index);
    }
    const passId = async () =>
      (
        await db
          .select({ passId: corpusIndexRouteProofs.passId })
          .from(corpusIndexRouteProofs)
          .where(eq(corpusIndexRouteProofs.indexId, ROUTE.indexId))
      ).at(0)?.passId ?? panic("The route has no proof row");
    expect((await advance()).type).toBe("advanced");
    const started = await passId();
    // Old, but still young enough for its end to prove the route.
    await agePass(CORPUS_INDEX_ROUTE_PROOF_MAX_AGE_HOURS - 1);

    expect(stepName(await advance())).toBe("present:advanced");
    expect(await passRow()).toMatchObject({
      passNumber: 1,
      passCursor: entityId(3),
      passInspected: 4,
    });
    expect(await passId()).toBe(started);
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
    const stale = started.type === "pass" ? started : panic("No pass");
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
    const fresh = restarted.type === "pass" ? restarted : panic("No pass");
    // Same number, same phase, same cursor: only the pass id tells them apart.
    expect(fresh.pass.number).toBe(stale.pass.number);
    expect(fresh.range).toMatchObject({
      index: stale.range.index,
      expectation: stale.range.expectation,
      cursor: stale.range.cursor,
    });
    expect(fresh.pass.id).not.toBe(stale.pass.id);
    expect(
      await runInTransaction(
        async (tx) =>
          await recordCorpusIndexRouteCensusPageTx(tx, {
            route: ROUTE,
            pass: stale.pass,
            range: stale.range,
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

  test("every page logs the pass's progress, its restarts since the last clean pass, and an estimate once one completed", async () => {
    for (const index of [0, 1, 2]) {
      // db-await-in-loop: a three-decision fixture
      await seedApplied(index);
    }
    const pages: Record<string, unknown>[] = [];
    setLogSinkForTesting(({ message, attributes }) => {
      if (message === "corpus_index.route_proof_page") {
        pages.push({ ...attributes });
      }
    });
    try {
      await advanceUntilProven();
      expect(pages.map(({ outcome, passRows }) => [outcome, passRows])).toEqual(
        [
          ["advanced", 2],
          ["phase_completed", 3],
          ["proven", 3],
        ],
      );
      expect(pages[0]).toMatchObject({
        index: ROUTE.indexId,
        passNumber: 1,
        phase: "present",
        pageLimit: PAGE,
        pageRows: 2,
        passPages: 1,
        restartsSinceProof: 0,
      });
      // Before any clean pass there is nothing to estimate from.
      expect(pages[0]).not.toHaveProperty("lastProofRows");
      expect(pages[0]).not.toHaveProperty("estimatedRemainingSeconds");

      // Drift restarts the pass: the next pass counts one restart and
      // estimates its remainder from the last clean pass's count.
      engine.delete(revisionId(1));
      await advance();
      expect(pages.at(-1)).toMatchObject({
        outcome: "drift",
        passNumber: 2,
        restartsSinceProof: 0,
      });
      await advance();
      // The repaired decision left the applied set: one page of the two left.
      expect(pages.at(-1)).toMatchObject({
        outcome: "phase_completed",
        passRows: 2,
        passNumber: 3,
        restartsSinceProof: 1,
        lastProofRows: 3,
      });
      expect(typeof pages.at(-1)?.["estimatedRemainingSeconds"]).toBe("number");
    } finally {
      resetLogSinkForTesting();
    }
  });
});

/** Applied revisions in two inserts, for fixtures larger than a page. */
const seedAppliedMany = async (indices: readonly number[]) => {
  await db.insert(corpusIndexProjectionIntents).values(
    indices.map((index) => ({
      id: revisionId(index),
      family: ROUTE.family,
      generation: ROUTE.generation,
      entityId: entityId(index),
      epoch: 1n,
      fingerprint: fingerprint(1),
      indexId: ROUTE.indexId,
      status: "applied" as const,
      appendStartedAt: APPLIED_AT,
      appendCommittedAt: APPLIED_AT,
      expectedDocumentCount: 3,
      appliedAt: APPLIED_AT,
    })),
  );
  await db.insert(corpusIndexProjectionStates).values(
    indices.map((index) => ({
      family: ROUTE.family,
      generation: ROUTE.generation,
      entityId: entityId(index),
      desiredAction: "upsert" as const,
      desiredEpoch: 1n,
      desiredFingerprint: fingerprint(1),
      desiredIndexId: ROUTE.indexId,
      appliedAction: "upsert" as const,
      appliedEpoch: 1n,
      appliedRevision: revisionId(index),
      appliedFingerprint: fingerprint(1),
      appliedIndexId: ROUTE.indexId,
      appliedAt: APPLIED_AT,
    })),
  );
  for (const index of indices) {
    engine.set(revisionId(index), { indexId: ROUTE.indexId, count: 3 });
  }
};

/**
 * Walk a pass split into `ranges` ranges one page at a time, taking the
 * ranges round robin as workers would, until it proves the route; each step
 * named `range:phase:outcome`.
 */
const advanceRangesUntilProven = async (ranges: number): Promise<string[]> => {
  const steps: string[] = [];
  for (let page = 0; page < 200; page += 1) {
    const range = page % ranges;
    // db-await-in-loop: each page reads the cursors the pages before recorded
    const { advance: step } = await advancePage(ROUTE, { range, ranges });
    if (step.type !== "range_idle") {
      steps.push(`${String(range)}:${stepName(step)}`);
    }
    if (step.type === "proven") {
      return steps;
    }
  }
  return panic(`The split pass did not end: ${steps.join(", ")}`);
};

/** Start one page of `range` of a pass split into `ranges`. */
const startRange = async (range: number, ranges: number) => {
  const started = await runInTransaction(
    async (tx) =>
      await startCorpusIndexRouteCensusPageTx(
        tx,
        ROUTE,
        present(incarnations.get(ROUTE.indexId) ?? panic("No incarnation")),
        { range, ranges },
      ),
  );
  return started.type === "pass" ? started : panic(`No pass: ${started.type}`);
};

/** The earliest start of the route's ranges, in epoch microseconds. */
const earliestRangeStartUs = async () => {
  const [row] = executedRowsOf(
    await db.execute(sql`
      SELECT (extract(epoch FROM min((laid.value ->> 'startedAt')::timestamptz))
        * 1000000)::bigint::text AS earliest
      FROM corpus_index_route_proofs,
        jsonb_array_elements(pass_ranges -> 'ranges') AS laid(value)
      WHERE index_id = ${ROUTE.indexId}
    `),
  );
  return isRecord(row) && typeof row["earliest"] === "string"
    ? row["earliest"]
    : panic("The route has no ranges");
};

const executedRowsOf = (result: unknown): unknown[] =>
  isRecord(result) && Array.isArray(result["rows"]) ? result["rows"] : [];

describe("a route pass split into key ranges", () => {
  test("proves exactly what one cursor proves, each revision read once", async () => {
    for (const index of Array.from({ length: 12 }, (_, at) => at)) {
      // db-await-in-loop: a twelve-decision fixture
      await seedApplied(index);
    }
    await seedSettled(12);
    await seedSettled(13);
    await seedWithdrawn(14);
    const every = Array.from({ length: 15 }, (_, at) =>
      revisionId(at),
    ).toSorted();

    const split = await advanceRangesUntilProven(4);
    // Four ranges each ended both phases; the last to end proved the route.
    expect(split.at(-1)).toMatch(/:absent:proven$/u);
    expect(
      split.filter((step) => step.endsWith(":absent:range_completed")),
    ).toHaveLength(3);
    const splitProof = await statusOf();
    expect(splitProof).toMatchObject({
      type: "current",
      inspected: 15,
      incarnation: `${ROUTE.indexId}:01JFIRST`,
    });
    // Every revision, applied or deleted, was read once and only once.
    expect(asked.toSorted()).toEqual(every);

    // The next pass is as small as this one's proof: one range, one cursor.
    asked = [];
    await advanceUntilProven();
    expect((await routePass()).ranges).toEqual([]);
    expect(await statusOf()).toMatchObject({
      type: "current",
      inspected: 15,
      incarnation: `${ROUTE.indexId}:01JFIRST`,
    });
    expect(asked.toSorted()).toEqual(every);
  });

  test("a range that ends on another incarnation proves nothing, and every range starts over", async () => {
    for (const index of [0, 1, 2, 3, 4, 5]) {
      // db-await-in-loop: a six-decision fixture
      await seedApplied(index);
    }
    const second = `${ROUTE.indexId}:01JSECOND`;
    const third = `${ROUTE.indexId}:01JTHIRD`;
    const untilRangeEnds = async (range: number) => {
      for (let page = 0; page < 20; page += 1) {
        // db-await-in-loop: each page reads the cursor the previous recorded
        const { advance: step } = await advancePage(ROUTE, {
          range,
          ranges: 2,
        });
        if (step.type === "range_completed" || step.type === "superseded") {
          return step.type;
        }
      }
      return panic(`Range ${String(range)} did not end`);
    };
    expect(await untilRangeEnds(0)).toBe("range_completed");
    expect((await routePass()).ranges.at(0)).toMatchObject({ completed: true });

    // Recreated before the other range's page: that page revokes, and the
    // range that had ended walks again on the new index.
    incarnations.set(ROUTE.indexId, second);
    expect(
      (await advancePage(ROUTE, { range: 1, ranges: 2 })).advance.type,
    ).toBe("advanced");
    const restarted = await routePass();
    expect(restarted.passIndexIncarnation).toBe(second);
    expect(restarted.ranges.at(0)).toMatchObject({
      completed: false,
      cursor: null,
      inspected: 0,
    });
    expect(await statusOf()).toEqual({ type: "never_proven" });

    // Recreated between a range's last census read and its end: that range
    // does not end, so the pass proves nothing.
    expect(await untilRangeEnds(0)).toBe("range_completed");
    expect(
      (await advancePage(ROUTE, { range: 1, ranges: 2 })).advance.type,
    ).toBe("phase_completed");
    switchIncarnation = {
      atRead: reads.incarnation + 2,
      indexId: ROUTE.indexId,
      to: third,
    };
    expect(
      (await advancePage(ROUTE, { range: 1, ranges: 2 })).advance.type,
    ).toBe("superseded");
    expect(await statusOf()).toEqual({ type: "never_proven" });

    // The pass on the new index proves the route on it alone.
    await advanceRangesUntilProven(2);
    expect(await statusOf()).toMatchObject({
      type: "current",
      incarnation: third,
      inspected: 6,
    });
  });

  test("a revocation during the pass restarts every range, and a page read before it is not recorded", async () => {
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
      // db-await-in-loop: an eight-decision fixture
      await seedApplied(index);
    }
    expect(
      (await advancePage(ROUTE, { range: 0, ranges: 2 })).advance.type,
    ).toBe("advanced");
    for (let page = 0; page < 10; page += 1) {
      // db-await-in-loop: each page reads the cursor the previous recorded
      const { advance: step } = await advancePage(ROUTE, {
        range: 1,
        ranges: 2,
      });
      if (step.type === "range_completed") {
        break;
      }
    }
    const before = await routePass();
    expect(before.ranges.map((range) => range["completed"])).toEqual([
      false,
      true,
    ]);

    const late = await startRange(0, 2);
    await runInTransaction(
      async (tx) =>
        await revokeCorpusIndexRouteProofTx(tx, ROUTE, "present_drift"),
    );
    expect(
      await runInTransaction(
        async (tx) =>
          await recordCorpusIndexRouteCensusPageTx(tx, {
            route: ROUTE,
            pass: late.pass,
            range: late.range,
            incarnation: `${ROUTE.indexId}:01JFIRST`,
            inspected: 2,
            nextCursor: entityId(3),
            complete: false,
          }),
      ),
    ).toEqual({ type: "superseded" });

    // The next page lays the new pass out: every range at its beginning.
    const fresh = await startRange(0, 2);
    expect(fresh.pass.number).toBe(before.passNumber + 1);
    expect(
      (fresh.pass.ranges ?? panic("The pass has no ranges")).map(
        ({ completed, cursor, inspected }) => ({
          completed,
          cursor,
          inspected,
        }),
      ),
    ).toEqual([
      { completed: false, cursor: null, inspected: 0 },
      { completed: false, cursor: null, inspected: 0 },
    ]);
    await advanceRangesUntilProven(2);
    expect(await statusOf()).toMatchObject({ type: "current", inspected: 8 });
  });

  test("two pages read on one range record once, and the range that ends last proves the route once", async () => {
    for (const index of [0, 1, 2, 3]) {
      // db-await-in-loop: a four-decision fixture
      await seedApplied(index);
    }
    const first = await startRange(0, 2);
    const second = await startRange(0, 2);
    const record = async (
      started: Awaited<ReturnType<typeof startRange>>,
      complete: boolean,
    ) =>
      await runInTransaction(
        async (tx) =>
          await recordCorpusIndexRouteCensusPageTx(tx, {
            route: ROUTE,
            pass: started.pass,
            range: started.range,
            incarnation: `${ROUTE.indexId}:01JFIRST`,
            // The range's first phase holds two decisions.
            inspected: started.range.through === null ? 0 : 2,
            nextCursor: started.range.through,
            complete,
          }),
      );
    expect(await record(first, true)).toEqual({ type: "phase_completed" });
    expect(await record(second, true)).toEqual({ type: "superseded" });
    expect((await routePass()).ranges.at(0)).toMatchObject({
      expectation: "absent",
      inspected: 2,
    });

    // Both ranges at their last page, read before either ends.
    for (const range of [0, 1]) {
      for (let page = 0; page < 10; page += 1) {
        // db-await-in-loop: each page reads the cursor the previous recorded
        const ready = await startRange(range, 2);
        if (ready.range.expectation === "absent") {
          break;
        }
        // db-await-in-loop: one page of the range's present phase
        await advancePage(ROUTE, { range, ranges: 2 });
      }
    }
    const zero = await startRange(0, 2);
    const one = await startRange(1, 2);
    expect(await record(one, true)).toEqual({ type: "range_completed" });
    expect(await statusOf()).toEqual({ type: "never_proven" });
    expect(await record(zero, true)).toEqual({ type: "proven" });
    expect(await record(zero, true)).toEqual({ type: "superseded" });
    expect(await statusOf()).toMatchObject({ type: "current", inspected: 4 });
  });

  test("a pass's age is its earliest range's: one range too old to prove restarts the pass, and a proof starts there", async () => {
    for (const index of [0, 1, 2, 3, 4, 5, 6, 7]) {
      // db-await-in-loop: an eight-decision fixture
      await seedApplied(index);
    }
    expect(
      (await advancePage(ROUTE, { range: 0, ranges: 2 })).advance.type,
    ).toBe("advanced");
    // Only the other range started past the maximum age; the pass row and
    // the walked range are young.
    await agePass(PAST_MAX_AGE_HOURS, { ranges: [1] });
    const restarts: Record<string, unknown>[] = [];
    setLogSinkForTesting(({ message, attributes }) => {
      if (message === "corpus_index.route_proof_pass_restarted") {
        restarts.push({ ...attributes });
      }
    });
    try {
      expect(
        (await advancePage(ROUTE, { range: 0, ranges: 2 })).advance.type,
      ).toBe("advanced");
    } finally {
      resetLogSinkForTesting();
    }
    expect(restarts).toEqual([
      expect.objectContaining({
        reason: "pass_too_old_to_prove",
        passNumber: 2,
        abandonedPassNumber: 1,
        abandonedPassAgeHours: PAST_MAX_AGE_HOURS,
      }),
    ]);

    // The new pass's one range started an hour before the other: its proof
    // is as old as that range.
    await agePass(1, { ranges: [1] });
    const earliest = await earliestRangeStartUs();
    await advanceRangesUntilProven(2);
    expect(await statusOf()).toMatchObject({
      type: "current",
      provenPassStartedAtUs: earliest,
    });
    // An hour old under a bound of one hour is already expired.
    expect((await statusOf(ROUTE.indexId, { maxAgeHours: 1 })).type).toBe(
      "expired",
    );
  });
});

/**
 * The route's pass as a single cursor left it mid-walk, begun `hours` ago:
 * its phase, its cursor and what it walked, with no ranges laid out.
 */
const standSingleCursorPass = async ({
  hours,
  expectation,
  cursor,
  through,
  inspected,
}: {
  hours: number;
  expectation: "present" | "absent";
  cursor: string | null;
  through: string;
  inspected: number;
}) => {
  await db.insert(corpusIndexRouteProofs).values({
    family: ROUTE.family,
    generation: ROUTE.generation,
    indexId: ROUTE.indexId,
    passStartedAt: sql`clock_timestamp() - ${hoursInterval(hours)}`,
    passExpectation: expectation,
    passCursor: cursor,
    passThrough: through,
    passInspected: inspected,
    passIndexIncarnation: `${ROUTE.indexId}:01JFIRST`,
  });
};

describe("a pass a single cursor began walking", () => {
  test("is split after its cursor, keeps its start and its count, and proves what the cursor would have", async () => {
    for (const index of Array.from({ length: 10 }, (_, at) => at)) {
      // db-await-in-loop: a ten-decision fixture
      await seedApplied(index);
    }
    await seedSettled(10);
    // Thirty hours in, the cursor has walked the first four decisions.
    await standSingleCursorPass({
      hours: 30,
      expectation: "present",
      cursor: entityId(3),
      through: entityId(9),
      inspected: 4,
    });

    const steps = await advanceRangesUntilProven(3);
    expect(steps.at(-1)).toMatch(/:absent:proven$/u);
    // Only what the cursor had not reached was read again.
    expect(asked.toSorted()).toEqual(
      [4, 5, 6, 7, 8, 9, 10].map(revisionId).toSorted(),
    );
    expect(await statusOf()).toMatchObject({ type: "current", inspected: 11 });
    // The same pass proved the route, and its proof is as old as the pass.
    expect(
      await db
        .select({ provenPassNumber: corpusIndexRouteProofs.provenPassNumber })
        .from(corpusIndexRouteProofs)
        .where(eq(corpusIndexRouteProofs.indexId, ROUTE.indexId)),
    ).toEqual([{ provenPassNumber: 1 }]);
    expect((await statusOf(ROUTE.indexId, { maxAgeHours: 29 })).type).toBe(
      "expired",
    );
    expect((await statusOf(ROUTE.indexId, { maxAgeHours: 31 })).type).toBe(
      "current",
    );
  });

  test("past its present phase is split over the deleted revisions after its cursor", async () => {
    for (const index of [0, 1, 2]) {
      // db-await-in-loop: a three-decision fixture
      await seedApplied(index);
    }
    for (const index of [10, 11, 12]) {
      // db-await-in-loop: three deleted revisions
      await seedSettled(index);
    }
    await standSingleCursorPass({
      hours: 2,
      expectation: "absent",
      cursor: revisionId(10),
      through: revisionId(12),
      inspected: 4,
    });

    await advanceRangesUntilProven(2);
    // Neither the applied revisions nor the deleted one walked are read again.
    expect(asked.toSorted()).toEqual([11, 12].map(revisionId).toSorted());
    expect(await statusOf()).toMatchObject({ type: "current", inspected: 6 });
  });

  test("begun at 128 revisions a page continues at a larger size, on the same pass, to the same proof", async () => {
    const indices = Array.from({ length: 300 }, (_, at) => at);
    await seedAppliedMany(indices);
    await seedSettled(400);
    const every = [...indices, 400].map(revisionId).toSorted();

    expect((await advancePage(ROUTE, { limit: 128 })).advance).toMatchObject({
      type: "advanced",
      inspected: 128,
    });
    const steps: string[] = [];
    for (let page = 0; page < 10; page += 1) {
      // db-await-in-loop: each page reads the cursor the previous recorded
      const { advance: step } = await advancePage(ROUTE, {
        limit: CORPUS_INDEX_ROUTE_CENSUS_PAGE_MAX,
      });
      steps.push(stepName(step));
      if (step.type === "proven") {
        break;
      }
    }
    expect(steps).toEqual(["present:phase_completed", "absent:proven"]);
    expect(asked.toSorted()).toEqual(every);
    expect(await statusOf()).toMatchObject({ type: "current", inspected: 301 });
  });
});

describe("census page size", () => {
  test("a census page names more revisions than a delete batch", async () => {
    const indices = Array.from({ length: 200 }, (_, at) => at);
    await seedAppliedMany(indices);
    const { advance: step } = await advancePage(ROUTE, {
      limit: CORPUS_INDEX_ROUTE_CENSUS_PAGE_MAX,
    });
    expect(step).toMatchObject({
      type: "phase_completed",
      expectation: "present",
      inspected: 200,
    });
    expect(reads.census).toBe(1);
    expect(asked).toHaveLength(200);
    expect(admitted).toEqual([
      { step: "census", revisions: CORPUS_INDEX_ROUTE_CENSUS_PAGE_MAX },
    ]);
  });

  test("a page that times out halves, and the walk goes on at the smaller size", async () => {
    const indices = Array.from({ length: 100 }, (_, at) => at);
    await seedAppliedMany(indices);
    censusTimesOutAbove = 40;
    let size = initialCorpusIndexRouteCensusPageSize();
    const limits: number[] = [];
    for (let page = 0; page < 20; page += 1) {
      limits.push(size.limit);
      // db-await-in-loop: each page reads the cursor the previous recorded
      const walked = await advanceCorpusIndexRouteProof({
        runInTransaction,
        client: engineClient,
        admit: governor,
        route: ROUTE,
        limit: size.limit,
      });
      if (walked.isErr()) {
        expect(isCorpusIndexReadTimeout(walked.error)).toBe(true);
        size = nextCorpusIndexRouteCensusPageSize(size, { type: "timed_out" });
        continue;
      }
      const { advance: step, censusMs } = walked.value;
      size = nextCorpusIndexRouteCensusPageSize(size, {
        type: "read",
        censusMs: censusMs ?? 0,
        revisions: "inspected" in step ? step.inspected : 0,
      });
      if (step.type === "phase_completed") {
        break;
      }
    }
    // 128 and 64 time out; 32 walks the hundred in four pages.
    expect(limits).toEqual([128, 64, 32, 32, 32, 32]);
    expect(asked.toSorted()).toEqual(indices.map(revisionId).toSorted());
    expect(await passRow()).toMatchObject({ passExpectation: "absent" });
  });

  test("the size halves on a slow or timed-out census, doubles after fast full pages, and stays in its bounds", () => {
    const start = initialCorpusIndexRouteCensusPageSize();
    expect(start).toEqual({ limit: 128, fast: 0 });
    const fastFull = (size: CorpusIndexRouteCensusPageSize) =>
      nextCorpusIndexRouteCensusPageSize(size, {
        type: "read",
        censusMs: 500,
        revisions: size.limit,
      });
    let size = start;
    for (let page = 0; page < 3; page += 1) {
      size = fastFull(size);
    }
    expect(size).toEqual({ limit: 128, fast: 3 });
    size = fastFull(size);
    expect(size).toEqual({ limit: 256, fast: 0 });
    for (let page = 0; page < 40; page += 1) {
      size = fastFull(size);
    }
    expect(size.limit).toBe(CORPUS_INDEX_ROUTE_CENSUS_PAGE_MAX);
    // A short page or a middling one says nothing about a larger one.
    expect(
      nextCorpusIndexRouteCensusPageSize(
        { limit: 128, fast: 3 },
        { type: "read", censusMs: 500, revisions: 100 },
      ),
    ).toEqual({ limit: 128, fast: 0 });
    expect(
      nextCorpusIndexRouteCensusPageSize(
        { limit: 128, fast: 3 },
        { type: "read", censusMs: 4000, revisions: 128 },
      ),
    ).toEqual({ limit: 128, fast: 0 });
    // Slower than half the timeout halves before the engine gives up.
    expect(
      nextCorpusIndexRouteCensusPageSize(
        { limit: 512, fast: 2 },
        { type: "read", censusMs: 6000, revisions: 512 },
      ),
    ).toEqual({ limit: 256, fast: 0 });
    size = { limit: 64, fast: 0 };
    for (let page = 0; page < 5; page += 1) {
      size = nextCorpusIndexRouteCensusPageSize(size, { type: "timed_out" });
    }
    expect(size).toEqual({
      limit: CORPUS_INDEX_ROUTE_CENSUS_PAGE_MIN,
      fast: 0,
    });
  });
});
