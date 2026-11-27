/**
 * Request caps under a long commit window, driven through the exported cycle
 * and store rather than a replica of their loops.
 *
 * A shared append whose outcome says nothing about which revision failed
 * halves its revisions' request caps instead of sending each of them alone.
 * Under a 600-second commit window a revision sent alone held its chain for
 * a whole window, so a backlog of them drained one or two a cycle. These
 * cases pin what replaced that: revisions of one cap travel together, a
 * chain still sends one request at a time, a failing request bisects down to
 * the revision at fault, no request starts on a lease shorter than the start
 * margin, and whatever a cycle did not start is handed back when it ends,
 * however it ends: a transaction that fails after a request was sent, or a
 * start that rolls back, leaves no reservation behind and no request running.
 *
 * Time passing inside the window is the reserved leases running short.
 */

import { panic, Result } from "better-result";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import { CorpusIndexError } from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { CORPUS_INDEX_PROJECTION_LEGACY_SINGLE_APPEND_REQUEST_CAP } from "@/api/lib/legal-search/corpus-index-projection-contract";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { legislationProjectionInputFromCanonical } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  CORPUS_PROJECTION_APPEND_COMMIT_MODE,
  corpusProjectionAppendStartMarginMs,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import { executeCorpusProjectionAppendCycle } from "@/api/lib/legal-search/corpus-index-projection-executor";
import {
  abandonCorpusProjectionAppendTx,
  cancelCorpusProjectionReservationsTx,
  type CorpusProjectionIntentLease,
  reserveCorpusProjectionIntentsTx,
  reserveCorpusProjectionRoutePageTx,
  startCorpusProjectionAppendBatchTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import { optOutOfCorpusProjectionSeedingGuard } from "@/api/tests/helpers/corpus-projection-seeding-guard";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TARGET = {
  family: "legislation",
  generation: "legislation_v3",
} as const;
const MANIFEST = CORPUS_INDEX_MANIFESTS.legislation_v3;
const SOURCE_ID = "0198e331-e578-7000-8000-0000000000c1";
const EPOCH = 3n;
const START_MARGIN_MS = corpusProjectionAppendStartMarginMs(MANIFEST);
const FULL_LEASE_MS = 15 * 60_000;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let nextDocument = 0;

const runInTransaction = async <TResult>(
  operation: (tx: Transaction) => Promise<TResult>,
): Promise<TResult> =>
  await db.transaction(
    async (tx) => await operation(asTestRaw<Transaction>(tx)),
  );

const documentId = (index: number): string =>
  `0198e331-e578-7000-8000-${String(index).padStart(12, "0")}`;

/** Fresh projectable legislation rows and their desired states. */
const seed = async (
  count: number,
): Promise<SafeId<"legislationDocument">[]> => {
  const rows = Array.from({ length: count }, () => {
    nextDocument += 1;
    const index = nextDocument;
    return {
      id: toSafeId<"legislationDocument">(documentId(index)),
      sourceId: toSafeId<"legislationSource">(SOURCE_ID),
      eli: `eli/cz/sb/2016/${1000 + index}`,
      title: `Act ${1000 + index}`,
      country: "CZE",
      language: "cs",
      documentType: "act",
      status: "current",
      effectiveDate: "2016-01-01",
      versionValidFrom: "2016-01-01",
      versionValidTo: null,
      contentHash: "b".repeat(64),
      textS3Key: `test-corpus/cap-${index}`,
      projectionEpoch: EPOCH,
    };
  });
  await db.insert(legislationDocuments).values(rows);
  await db.insert(corpusIndexProjectionStates).values(
    rows.map((row) => {
      const descriptor = deriveCorpusIndexProjectionDescriptor(
        MANIFEST,
        legislationProjectionInputFromCanonical({
          documentId: row.id,
          sourceId: row.sourceId,
          jurisdiction: row.country,
          language: row.language,
          documentType: row.documentType,
          contentHash: row.contentHash,
          title: row.title,
          status: row.status,
          effectiveDate: row.effectiveDate,
          versionValidFrom: row.versionValidFrom,
          versionValidTo: row.versionValidTo,
          eli: row.eli,
          sourceDescriptor: null,
          ...EFFECTIVE_CONSOLIDATION,
        }),
      );
      if (descriptor.action !== "upsert") {
        return panic("Seeded legislation row is not projectable");
      }
      return {
        ...TARGET,
        entityId: String(row.id),
        desiredAction: "upsert" as const,
        desiredEpoch: EPOCH,
        desiredFingerprint: descriptor.fingerprint,
        desiredIndexId: descriptor.indexId,
      };
    }),
  );
  return rows.map(({ id }) => id);
};

const states = async (entityIds: readonly string[]) =>
  await db
    .select({
      entityId: corpusIndexProjectionStates.entityId,
      workStatus: corpusIndexProjectionStates.workStatus,
      failureAttempts: corpusIndexProjectionStates.failureAttempts,
      appendMode: corpusIndexProjectionStates.appendMode,
      appendRequestCap: corpusIndexProjectionStates.appendRequestCap,
      appliedRevision: corpusIndexProjectionStates.appliedRevision,
    })
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.generation, TARGET.generation),
        inArray(corpusIndexProjectionStates.entityId, [...entityIds]),
      ),
    )
    .orderBy(corpusIndexProjectionStates.entityId);

const readDatabaseClock = async (): Promise<Date> => {
  const value = (
    await client.query<{ now: Date | string }>(
      "SELECT clock_timestamp() AS now",
    )
  ).rows.at(0)?.now;
  return value instanceof Date
    ? value
    : new Date(value ?? panic("PostgreSQL returned no clock"));
};

const intentsWithStatus = async (
  entityIds: readonly string[],
  status: "reserved" | "cancelled",
) =>
  await db
    .select({
      entityId: corpusIndexProjectionIntents.entityId,
      lastError: corpusIndexProjectionIntents.lastError,
    })
    .from(corpusIndexProjectionIntents)
    .where(
      and(
        inArray(corpusIndexProjectionIntents.entityId, [...entityIds]),
        eq(corpusIndexProjectionIntents.status, status),
      ),
    );

/** Cleanup of the failed revisions, modelled as done, and their retry due. */
const makeRetryDue = async (entityIds: readonly string[]) => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1937007986, 1)`);
    await tx
      .update(corpusIndexGenerations)
      .set({ status: "retiring" })
      .where(eq(corpusIndexGenerations.generation, TARGET.generation));
    await tx
      .delete(corpusIndexProjectionIntents)
      .where(
        and(
          inArray(corpusIndexProjectionIntents.entityId, [...entityIds]),
          inArray(corpusIndexProjectionIntents.status, [
            "cleanup_pending",
            "cancelled",
          ]),
        ),
      );
    await tx
      .update(corpusIndexGenerations)
      .set({ status: "building" })
      .where(eq(corpusIndexGenerations.generation, TARGET.generation));
  });
  await db
    .update(corpusIndexProjectionStates)
    .set({ retryNotBefore: new Date(0) })
    .where(
      and(
        inArray(corpusIndexProjectionStates.entityId, [...entityIds]),
        eq(corpusIndexProjectionStates.workStatus, "retry_scheduled"),
      ),
    );
};

type Ingest = (ndjson: string) => Promise<Result<void, CorpusIndexError>>;

type AppendCycleOptions = Parameters<
  typeof executeCorpusProjectionAppendCycle
>[0];

/**
 * The engine fake: records each request as its revision list, publishes what
 * `ingest` accepts, and counts the requests in flight, so a test can see that
 * a chain sends one at a time and that none outlives the cycle.
 */
const fakeEngine = (ingest: Ingest) => {
  const published = new Map<string, number>();
  const requests: string[][] = [];
  const bodies: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const engineClient: AppendCycleOptions["client"] = {
    ingestCommittedBatch: async ({ ndjson }) => {
      const revisions = ndjson.split("\n").map((line) => {
        const { projection_revision } = JSON.parse(line);
        return typeof projection_revision === "string"
          ? projection_revision
          : panic("A sent document has no revision");
      });
      requests.push(revisions);
      bodies.push(ndjson);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const outcome = await ingest(ndjson);
      inFlight -= 1;
      if (outcome.isOk()) {
        for (const revision of revisions) {
          published.set(revision, (published.get(revision) ?? 0) + 1);
        }
      }
      return outcome;
    },
    ingestQueuedBatch: async () =>
      panic("Projection append must wait for publication"),
    aggregate: async ({ query }) =>
      Result.ok({
        projection_revisions: {
          buckets: Array.from(published, ([key, doc_count]) => ({
            key,
            doc_count,
          })).filter(({ key }) => query.includes(`"${key}"`)),
          doc_count_error_upper_bound: 0,
          sum_other_doc_count: 0,
        },
      }),
  };
  return {
    client: engineClient,
    requests,
    bodies,
    inFlight: () => inFlight,
    peak: () => peak,
    sizes: () =>
      requests
        .map(({ length }) => length)
        .toSorted((left, right) => left - right),
  };
};

const accepting: Ingest = async () => Result.ok(undefined);

/** One cycle of the generation. */
const runCycle = async ({
  entityIds,
  engine,
  transactions = runInTransaction,
}: {
  entityIds: readonly SafeId<"legislationDocument">[];
  engine: ReturnType<typeof fakeEngine>;
  transactions?: AppendCycleOptions["runInTransaction"];
}) =>
  await executeCorpusProjectionAppendCycle({
    runInTransaction: transactions,
    client: engine.client,
    commitMode: CORPUS_PROJECTION_APPEND_COMMIT_MODE.published,
    ...TARGET,
    scope: { type: "subjects", entityIds },
    limit: entityIds.length,
    fillWindowMs: 120_000,
    payloadReadConcurrency: 4,
    retryDelayMs: 5000,
    payloadRetryLimit: 3,
    proofAfterIndexId: null,
    payloadReader: async () =>
      Result.ok({
        text: "An act of the long commit window.",
        ast: null,
        storedAst: { type: "absent" } as const,
      }),
  });

const setCap = async (
  entityIds: readonly string[],
  appendRequestCap: number,
) => {
  await db
    .update(corpusIndexProjectionStates)
    .set({ appendRequestCap })
    .where(inArray(corpusIndexProjectionStates.entityId, [...entityIds]));
};

/** How many of `entityIds` have an append started, as `tx` sees it. */
const countStarted = async (
  tx: FixtureTransaction,
  entityIds: readonly string[],
): Promise<number> =>
  (
    await tx
      .select({ id: corpusIndexProjectionIntents.id })
      .from(corpusIndexProjectionIntents)
      .where(
        and(
          inArray(corpusIndexProjectionIntents.entityId, [...entityIds]),
          eq(corpusIndexProjectionIntents.status, "append_started"),
        ),
      )
  ).length;

const reserve = async (
  entityIds: readonly SafeId<"legislationDocument">[],
  { leaseMs, testNow }: { leaseMs: number; testNow?: Date },
): Promise<CorpusProjectionIntentLease[]> =>
  await runInTransaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(tx, {
        ...TARGET,
        scope: { type: "subjects", entityIds },
        limit: entityIds.length,
        leaseMs,
        ...(testNow === undefined ? {} : { testNow }),
      }),
  );

beforeAll(async () => {
  client = await createTestPglite();
  await optOutOfCorpusProjectionSeedingGuard(client, {
    reason:
      "Exercises the projection store and executor on canonical rows and desired states this suite stands up as fixtures; no desired writer runs here, and the writer suites keep the guard.",
  });
  db = drizzle({ client });
  await db.insert(corpusIndexGenerations).values({
    ...TARGET,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(MANIFEST),
    status: "building",
  });
  await db.insert(legislationSources).values({
    id: toSafeId<"legislationSource">(SOURCE_ID),
    adapterKey: "request-cap-collection",
    name: "Request cap collection",
    descriptor: null,
  });
});

beforeEach(() => {
  expect(
    MANIFEST.engine.indexConfig.indexing_settings.commit_timeout_secs,
  ).toBe(600);
});

afterAll(async () => {
  await client.close();
});

test("a reservation carries each entity's request cap, a legacy single mark read as the legacy cap", async () => {
  const seeded = await seed(3);
  const legacy = seeded.at(0) ?? panic("Expected a legacy entity");
  const capped = seeded.at(1) ?? panic("Expected a capped entity");
  const full = seeded.at(2) ?? panic("Expected a full entity");
  await db.execute(
    sql`UPDATE ${corpusIndexProjectionStates} SET append_mode = 'single' WHERE entity_id = ${legacy}`,
  );
  await db
    .update(corpusIndexProjectionStates)
    .set({ appendRequestCap: 8 })
    .where(eq(corpusIndexProjectionStates.entityId, capped));
  const leases = await reserve([legacy, capped, full], {
    leaseMs: FULL_LEASE_MS,
  });
  expect(
    Object.fromEntries(
      leases.map(({ entityId, appendRequestCap }) => [
        entityId,
        appendRequestCap,
      ]),
    ),
  ).toEqual({
    [legacy]: CORPUS_INDEX_PROJECTION_LEGACY_SINGLE_APPEND_REQUEST_CAP,
    [capped]: 8,
    [full]: 512,
  });
  await runInTransaction(async (tx) => {
    for (const lease of leases) {
      // db-await-in-loop: three fixture rows, one start and abandon each
      await startCorpusProjectionAppendBatchTx(tx, { leases: [lease] });
    }
    // A request of 32 that failed without saying which revision failed.
    await tx
      .update(corpusIndexProjectionIntents)
      .set({ appendRequestRevisionCount: 32 })
      .where(
        inArray(
          corpusIndexProjectionIntents.id,
          leases.map(({ intentId }) => intentId),
        ),
      );
    for (const lease of leases) {
      // db-await-in-loop: three fixture rows, one start and abandon each
      await abandonCorpusProjectionAppendTx(tx, {
        intentId: lease.intentId,
        leaseToken: lease.leaseToken,
        errorMessage: "shared request outcome unknown",
      });
    }
  });
  // Halved from what each could share, never raised; the legacy mark goes.
  const settled = Object.fromEntries(
    (await states([legacy, capped, full])).map(
      ({ entityId, appendMode, appendRequestCap, failureAttempts }) => [
        entityId,
        { appendMode, appendRequestCap, failureAttempts },
      ],
    ),
  );
  const halved = (appendRequestCap: number) => ({
    appendMode: "batchable" as const,
    appendRequestCap,
    failureAttempts: 0,
  });
  expect(settled).toEqual({
    [legacy]: halved(16),
    [capped]: halved(8),
    [full]: halved(16),
  });
});

test("a route page takes only entities at the full request cap", async () => {
  const seeded = await seed(2);
  const capped = seeded.at(0) ?? panic("Expected a capped entity");
  const full = seeded.at(1) ?? panic("Expected a full entity");
  await db
    .update(corpusIndexProjectionStates)
    .set({ appendRequestCap: 4 })
    .where(eq(corpusIndexProjectionStates.entityId, capped));
  const indexId =
    (
      await db
        .select({ indexId: corpusIndexProjectionStates.desiredIndexId })
        .from(corpusIndexProjectionStates)
        .where(eq(corpusIndexProjectionStates.entityId, full))
    ).at(0)?.indexId ?? panic("Expected the seeded route");
  const page = await runInTransaction(
    async (tx) =>
      await reserveCorpusProjectionRoutePageTx(tx, {
        ...TARGET,
        indexId,
        after: null,
        skipEntityIds: [],
        limit: 512,
        leaseMs: FULL_LEASE_MS,
      }),
  );
  if (page.type !== "page") {
    panic("The building generation refused a route page");
  }
  const taken = new Set(page.leases.map(({ entityId }) => entityId));
  expect(taken.has(full)).toBe(true);
  expect(taken.has(capped)).toBe(false);
  expect(
    await runInTransaction(
      async (tx) =>
        await cancelCorpusProjectionReservationsTx(tx, {
          leases: page.leases,
          errorMessage: "route page fixture handed back",
        }),
    ),
  ).toEqual({ cancelled: page.leases.length, leaseLost: 0 });
});

test("an append starts only while its lease covers the generation's start margin", async () => {
  const entityIds = await seed(2);
  // Ahead of every state's queue position, so both are runnable.
  const reservedAt = new Date((await readDatabaseClock()).getTime() + 60_000);
  const short =
    (
      await reserve(entityIds.slice(0, 1), {
        leaseMs: START_MARGIN_MS - 1000,
        testNow: reservedAt,
      })
    ).at(0) ?? panic("Expected the short reservation");
  const covered =
    (
      await reserve(entityIds.slice(1), {
        leaseMs: START_MARGIN_MS,
        testNow: reservedAt,
      })
    ).at(0) ?? panic("Expected the covered reservation");
  const starts = await runInTransaction(
    async (tx) =>
      await startCorpusProjectionAppendBatchTx(tx, {
        leases: [short],
        testNow: reservedAt,
      }),
  );
  expect(starts).toEqual([
    { intentId: short.intentId, status: "lease_ends_before_run" },
  ]);
  // Left reserved for the caller to hand back, not cancelled or charged.
  expect(
    (await intentsWithStatus([short.entityId], "reserved")).map(
      ({ entityId }) => entityId,
    ),
  ).toEqual([short.entityId]);
  expect(
    await runInTransaction(
      async (tx) =>
        await startCorpusProjectionAppendBatchTx(tx, {
          leases: [covered],
          testNow: reservedAt,
        }),
    ),
  ).toEqual([{ intentId: covered.intentId, status: "started" }]);
});

test("legacy single entities are grouped into shared requests sent one at a time", async () => {
  const entityIds = await seed(40);
  await db.execute(
    sql`UPDATE ${corpusIndexProjectionStates} SET append_mode = 'single' WHERE entity_id IN (${sql.join(
      entityIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`,
  );
  const engine = fakeEngine(accepting);
  const result = await runCycle({ entityIds, engine });
  // Two requests of the legacy cap and the rest, not forty of one, and never
  // more than one in flight: the chain's byte budget is one request.
  expect(engine.sizes()).toEqual([8, 32]);
  expect(engine.peak()).toBe(1);
  expect(result.status).toBe("completed");
  expect(result.requestCount).toBe(2);
  expect(result.applied).toBe(40);
  expect(result.cancelled).toBe(0);
  for (const state of await states(entityIds)) {
    expect(state.appliedRevision).not.toBeNull();
    expect(state.appendMode).toBe("batchable");
    expect(state.appendRequestCap).toBe(512);
  }
});

test("a failing shared request bisects down to the revision at fault while its mates apply", async () => {
  const entityIds = await seed(8);
  const poisoned = entityIds.at(3) ?? panic("Expected a poisoned entity");
  const engine = fakeEngine(async (ndjson) =>
    ndjson.includes(poisoned)
      ? Result.err(
          new CorpusIndexError({
            message: "request rejected",
            status: 413,
            rejection: "definite",
          }),
        )
      : Result.ok(undefined),
  );
  const settledOf = async () =>
    (await states(entityIds)).filter(
      ({ entityId, appliedRevision, workStatus }) =>
        entityId === poisoned
          ? workStatus === "blocked"
          : appliedRevision !== null,
    ).length;
  // A failed request closes its chain, so its mates that were not sent wait
  // for the next cycle; the bound only stops a regression from looping.
  for (let cycle = 0; cycle < 12 && (await settledOf()) < 8; cycle += 1) {
    // db-await-in-loop: one append cycle per bisection round, bounded above
    await runCycle({ entityIds, engine });
    // db-await-in-loop: cleanup of the round's failed request, modelled as done
    await makeRetryDue(entityIds);
  }
  expect(await settledOf()).toBe(8);
  expect(engine.peak()).toBe(1);
  // Each request that carried the fault was half the one before, down to
  // the revision alone, which is charged twice and blocked.
  expect(
    engine.requests
      .filter((_, index) => engine.bodies.at(index)?.includes(poisoned))
      .map(({ length }) => length),
  ).toEqual([8, 4, 2, 1, 1]);
  expect(
    (await states(entityIds)).find(({ entityId }) => entityId === poisoned),
  ).toMatchObject({
    workStatus: "blocked",
    failureAttempts: 2,
    appendRequestCap: 1,
  });
});

test("a cycle starts nothing on a lease inside the start margin and hands the rest back", async () => {
  const entityIds = await seed(5);
  await setCap(entityIds, 1);
  // The window passes while the first request is in flight: what is still
  // reserved now has less lease left than a request needs.
  const engine = fakeEngine(async () => {
    await db.execute(
      sql`UPDATE ${corpusIndexProjectionIntents}
        SET lease_expires_at = clock_timestamp() + interval '60 seconds'
        WHERE status = 'reserved'
          AND entity_id IN (${sql.join(
            entityIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
    );
    return Result.ok(undefined);
  });
  const result = await runCycle({ entityIds, engine });
  expect(engine.sizes()).toEqual([1]);
  expect(result.status).toBe("completed");
  expect(result.applied).toBe(1);
  expect(result.cancelled).toBe(4);
  await expectHandedBack(entityIds, 4);
  const waiting = (await states(entityIds)).filter(
    ({ appliedRevision }) => appliedRevision === null,
  );
  // Uncharged and still at their place in the queue.
  expect(
    waiting.map(({ workStatus, failureAttempts }) => ({
      workStatus,
      failureAttempts,
    })),
  ).toEqual(
    Array.from({ length: 4 }, () => ({
      workStatus: "eligible",
      failureAttempts: 0,
    })),
  );
  const waitingIds = new Set(waiting.map(({ entityId }) => entityId));
  expect(
    await reserve(
      entityIds.filter((id) => waitingIds.has(id)),
      { leaseMs: FULL_LEASE_MS },
    ),
  ).toHaveLength(4);
});

/** None of `entityIds` is still reserved; `count` went back by hand-back. */
const expectHandedBack = async (
  entityIds: readonly string[],
  count: number,
) => {
  expect(await intentsWithStatus(entityIds, "reserved")).toEqual([]);
  const handedBack = (await intentsWithStatus(entityIds, "cancelled")).filter(
    ({ lastError }) =>
      lastError ===
      "projection append handed back a reservation it did not start",
  );
  expect(handedBack).toHaveLength(count);
};

type FixtureTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Runs each transaction of the cycle, and fails the first one `fails` picks
 * after its work and before its commit, so it rolls back. `fails` sees how
 * many of the fixture's appends were started before and after the work, as
 * the transaction itself sees them.
 */
const failingOnce = (
  entityIds: readonly string[],
  fails: (started: { before: number; after: number }) => boolean,
): AppendCycleOptions["runInTransaction"] => {
  let failed = false;
  return async (operation) =>
    await db.transaction(async (tx) => {
      const before = await countStarted(tx, entityIds);
      const value = await operation(asTestRaw<Transaction>(tx));
      if (
        !failed &&
        fails({ before, after: await countStarted(tx, entityIds) })
      ) {
        failed = true;
        return panic("injected transaction failure");
      }
      return value;
    });
};

test("a transaction that fails after a request was sent hands back what the cycle did not start", async () => {
  const entityIds = await seed(8);
  await setCap(entityIds, 4);
  const engine = fakeEngine(accepting);
  const exit = { inFlight: -1 };
  const failure = await rejectionOf(
    runCycle({
      entityIds,
      engine,
      // The first transaction after the first request: its acceptance.
      transactions: failingOnce(entityIds, () => engine.requests.length === 1),
    }).finally(() => {
      exit.inFlight = engine.inFlight();
    }),
  );
  expect(String(failure)).toContain("injected transaction failure");
  // The cycle did not return while a request was running, sent nothing
  // after the failure, and left no reservation of its own behind.
  expect(exit.inFlight).toBe(0);
  expect(engine.sizes()).toEqual([4]);
  await expectHandedBack(entityIds, 4);
});

test("a start transaction that rolls back leaves no reservation behind", async () => {
  const entityIds = await seed(8);
  await setCap(entityIds, 4);
  const engine = fakeEngine(accepting);
  const exit = { inFlight: -1 };
  const failure = await rejectionOf(
    runCycle({
      entityIds,
      engine,
      // The second request's start: its transaction starts appends and then
      // rolls back, so its revisions are still reserved.
      transactions: failingOnce(
        entityIds,
        ({ before, after }) => engine.requests.length === 1 && after > before,
      ),
    }).finally(() => {
      exit.inFlight = engine.inFlight();
    }),
  );
  expect(String(failure)).toContain("injected transaction failure");
  expect(exit.inFlight).toBe(0);
  expect(engine.sizes()).toEqual([4]);
  // The first request was sent, accepted and proven before the failure.
  expect(
    (await states(entityIds)).filter(
      ({ appliedRevision }) => appliedRevision !== null,
    ),
  ).toHaveLength(4);
  await expectHandedBack(entityIds, 4);
});
