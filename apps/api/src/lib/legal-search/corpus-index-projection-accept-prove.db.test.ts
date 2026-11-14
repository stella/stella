import { panic, Result, TaggedError } from "better-result";
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";
import { dbClock } from "@stll/test-kit/db";

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
import { recoverExpiredCorpusProjectionIntentsTx } from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { legislationProjectionInputFromCanonical } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  CORPUS_PROJECTION_APPEND_COMMIT_MODE,
  corpusIndexAppendPublishDelayMs,
  proveCorpusProjectionRevisionsPresent,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import { advanceCorpusProjectionErasuresTx } from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import { executeCorpusProjectionAppendCycle } from "@/api/lib/legal-search/corpus-index-projection-executor";
import {
  CORPUS_PROJECTION_PROOF_CYCLE_MAX_REVISIONS,
  executeCorpusProjectionProofCycle,
} from "@/api/lib/legal-search/corpus-index-projection-prover";
import {
  type AcceptedCorpusProjectionAppendProof,
  CORPUS_PROJECTION_UNPROVEN_BYTES_BUDGET_MAX,
  type CorpusProjectionProofTiming,
  proveAcceptedCorpusProjectionAppendsTx,
  recordAcceptedCorpusProjectionAppendsTx,
  reserveCorpusProjectionIntentsTx,
  retireAcceptedCorpusProjectionAppendsTx,
  startCorpusProjectionAppendTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import { logger } from "@/api/lib/observability/logger";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TARGET = {
  family: "legislation",
  generation: "legislation_v2",
} as const;
const MANIFEST = CORPUS_INDEX_MANIFESTS.legislation_v2;
/** One commit window plus margin: barrier after acceptance, deadline after barrier. */
const PUBLISH_DELAY_MS = corpusIndexAppendPublishDelayMs(MANIFEST);
const SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-0000000007f1",
);
const EPOCH = 3n;
const ENTITIES_PER_RUN = 3;
const PAYLOAD = { text: "A published act.", ast: null } as const;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let nextDocument = 1;

/** A process death at one exact point; nothing after it runs. */
class SimulatedCrash extends TaggedError("SimulatedCrash")<{
  message: string;
}> {}

const seedEntities = async (count: number) => {
  const rows = Array.from({ length: count }, () => {
    const index = nextDocument;
    nextDocument += 1;
    return {
      id: toSafeId<"legislationDocument">(
        `0198e331-e578-7000-8000-${String(index).padStart(12, "0")}`,
      ),
      sourceId: SOURCE_ID,
      eli: `eli/cz/sb/2016/${index}`,
      title: `Act ${index}`,
      country: "CZE",
      language: "cs",
      documentType: "act",
      status: "current",
      effectiveDate: "2016-01-01",
      versionValidFrom: "2016-01-01",
      versionValidTo: null,
      contentHash: "b".repeat(64),
      textS3Key: `test-corpus/${index}`,
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
  return rows.map(({ id }) => String(id));
};

/**
 * The engine as the projection sees it: documents an ingest accepted but no
 * commit published yet, and the documents a census can count.
 */
type FakeEngine = {
  unpublished: Map<string, number>;
  published: Map<string, number>;
  /** Indexes whose census answers with an outage, and how many more times. */
  censusOutages: Map<string, number>;
  /** Exact counts each census returned, per revision, since the last reset. */
  censused: Map<string, number>;
};

const createEngine = (): FakeEngine => ({
  censusOutages: new Map(),
  unpublished: new Map(),
  published: new Map(),
  censused: new Map(),
});

const addCount = (counts: Map<string, number>, key: string, by: number) => {
  const next = (counts.get(key) ?? 0) + by;
  if (next === 0) {
    counts.delete(key);
  } else {
    counts.set(key, next);
  }
};

/** Where one command dies: a transaction (before it or rolled back) or an engine call. */
type CrashPoint =
  | { type: "none" }
  | { type: "transaction"; index: number; phase: "before" | "rollback" }
  | { type: "ingest" }
  | { type: "census" };

type Harness = {
  engine: FakeEngine;
  crash: CrashPoint;
  transactions: number;
};

const crashIf = (harness: Harness, matches: boolean, at: string) => {
  if (matches) {
    harness.crash = { type: "none" };
    throw new SimulatedCrash({ message: `process died at ${at}` });
  }
};

const transactionRunner =
  (harness: Harness) =>
  async <TResult>(
    operation: (tx: Transaction) => Promise<TResult>,
  ): Promise<TResult> => {
    const index = harness.transactions;
    harness.transactions += 1;
    const { crash } = harness;
    const dies = crash.type === "transaction" && crash.index === index;
    crashIf(harness, dies && crash.phase === "before", `transaction ${index}`);
    return await db.transaction(async (tx) => {
      const value = await operation(asTestRaw<Transaction>(tx));
      crashIf(harness, dies, `commit of transaction ${index}`);
      return value;
    });
  };

/** How the engine takes one accepted request. */
type IngestBehavior = {
  /** Commit at once, as a request waiting for publication sees it. */
  publishOnAccept: boolean;
  /** Write the request's first document twice, so a census counts excess. */
  duplicate: boolean;
};

const PROVER_ENGINE = {
  publishOnAccept: true,
  duplicate: false,
} as const satisfies IngestBehavior;

const engineClient = (
  harness: Harness,
  { publishOnAccept, duplicate }: IngestBehavior,
) => ({
  ingestCommittedBatch: async ({
    ndjson,
  }: {
    ndjson: string;
  }): Promise<Result<void, CorpusIndexError>> => {
    const lines = ndjson.split("\n");
    for (const line of duplicate ? [...lines, ...lines.slice(0, 1)] : lines) {
      const { projection_revision: revision } = JSON.parse(line);
      if (typeof revision !== "string") {
        return panic("Projection document has no revision");
      }
      addCount(
        publishOnAccept ? harness.engine.published : harness.engine.unpublished,
        revision,
        1,
      );
    }
    crashIf(harness, harness.crash.type === "ingest", "ingest receipt");
    return Result.ok(undefined);
  },
  ingestQueuedBatch: async () =>
    panic("Projection append must wait for publication"),
  aggregate: async ({ indexId, query }: { indexId: string; query: string }) => {
    crashIf(harness, harness.crash.type === "census", "census");
    const outages = harness.engine.censusOutages.get(indexId) ?? 0;
    if (outages > 0) {
      harness.engine.censusOutages.set(indexId, outages - 1);
      return Result.err(
        new CorpusIndexError({ message: "search unavailable", status: 503 }),
      );
    }
    const buckets = Array.from(harness.engine.published, ([key, count]) => ({
      key,
      doc_count: count,
    })).filter(({ key }) => query.includes(`"${key}"`));
    for (const { key, doc_count } of buckets) {
      harness.engine.censused.set(key, doc_count);
    }
    return Result.ok({
      projection_revisions: {
        buckets,
        doc_count_error_upper_bound: 0,
        sum_other_doc_count: 0,
      },
    });
  },
});

const survive = async (run: () => Promise<unknown>) => {
  const outcome = await Result.tryPromise({
    try: run,
    catch: (cause) => cause,
  });
  if (outcome.isErr() && !SimulatedCrash.is(outcome.error)) {
    throw outcome.error;
  }
};

const readIntents = async (entityIds: readonly string[]) =>
  await db
    .select({
      id: corpusIndexProjectionIntents.id,
      entityId: corpusIndexProjectionIntents.entityId,
      status: corpusIndexProjectionIntents.status,
      leaseToken: corpusIndexProjectionIntents.leaseToken,
      expectedDocumentCount: corpusIndexProjectionIntents.expectedDocumentCount,
      appendPublishBarrierAt:
        corpusIndexProjectionIntents.appendPublishBarrierAt,
    })
    .from(corpusIndexProjectionIntents)
    .where(inArray(corpusIndexProjectionIntents.entityId, [...entityIds]));

const readStates = async (entityIds: readonly string[]) =>
  await db
    .select({
      entityId: corpusIndexProjectionStates.entityId,
      desiredAction: corpusIndexProjectionStates.desiredAction,
      desiredEpoch: corpusIndexProjectionStates.desiredEpoch,
      appliedRevision: corpusIndexProjectionStates.appliedRevision,
      workStatus: corpusIndexProjectionStates.workStatus,
    })
    .from(corpusIndexProjectionStates)
    .where(inArray(corpusIndexProjectionStates.entityId, [...entityIds]));

type Command =
  | ({ type: "append"; crash: CrashPoint } & IngestBehavior)
  | { type: "publish" }
  | { type: "lose_unpublished" }
  | { type: "miscount"; entity: number; by: -1 | 1 }
  | { type: "advance"; ms: number }
  | { type: "prove"; crash: CrashPoint }
  | { type: "double_prove" }
  | { type: "change_desired"; entity: number }
  | { type: "erase"; entity: number }
  | { type: "sweep" };

const crashPoint: fc.Arbitrary<CrashPoint> = fc.oneof(
  fc.constant({ type: "none" } as const),
  fc.record({
    type: fc.constant("transaction" as const),
    index: fc.integer({ min: 0, max: 5 }),
    phase: fc.constantFrom("before" as const, "rollback" as const),
  }),
  fc.constant({ type: "ingest" } as const),
  fc.constant({ type: "census" } as const),
);

const entity = fc.integer({ min: 0, max: ENTITIES_PER_RUN - 1 });

const command: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      type: fc.constant("append" as const),
      publishOnAccept: fc.boolean(),
      duplicate: fc.boolean(),
      crash: crashPoint,
    }),
  },
  { weight: 2, arbitrary: fc.constant({ type: "publish" } as const) },
  { weight: 1, arbitrary: fc.constant({ type: "lose_unpublished" } as const) },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("miscount" as const),
      entity,
      by: fc.constantFrom(-1 as const, 1 as const),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant("advance" as const),
      ms: fc.constantFrom(PUBLISH_DELAY_MS + 1000, 2 * PUBLISH_DELAY_MS + 1000),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      type: fc.constant("prove" as const),
      crash: crashPoint,
    }),
  },
  { weight: 1, arbitrary: fc.constant({ type: "double_prove" } as const) },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("change_desired" as const),
      entity,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ type: fc.constant("erase" as const), entity }),
  },
  { weight: 1, arbitrary: fc.constant({ type: "sweep" } as const) },
);

/** What a second prover holding the same census finds after the first. */
const PROOF_CYCLE_TIMING = {
  type: "after_barrier",
} as const satisfies CorpusProjectionProofTiming;
const WAITED_REQUEST = {
  type: "request_waited",
  failureMessage: "projection append is not fully searchable after publication",
} as const satisfies CorpusProjectionProofTiming;

const REPEATED_PROOF = {
  applied: "already_applied",
  already_applied: "already_applied",
  stale_cleanup_pending: "not_accepted",
  unproven_cleanup_pending: "not_accepted",
  blocked: "not_accepted",
  awaiting_publication: "awaiting_publication",
  not_accepted: "not_accepted",
} as const satisfies Record<
  AcceptedCorpusProjectionAppendProof["status"],
  AcceptedCorpusProjectionAppendProof["status"]
>;

type ModelRun = {
  harness: Harness;
  entityIds: string[];
  /** Every seeded entity projects into this one index. */
  indexId: string;
  /** Virtual time the prover and the sweep run at, ahead of the wall clock. */
  offsetMs: number;
};

/** The database clock moved ahead by the run's virtual offset. */
const now = async (run: ModelRun) => {
  const row = (
    await db.execute<{ ms: number }>(
      sql`SELECT (extract(epoch FROM ${dbClock.fromNow(run.offsetMs)}) * 1000)::float8 AS ms`,
    )
  ).rows.at(0);
  return new Date(row?.ms ?? panic("The database returned no clock"));
};

const acceptedIntentOf = async (run: ModelRun, index: number) =>
  (await readIntents(run.entityIds)).find(
    (intent) =>
      intent.entityId === run.entityIds.at(index) &&
      intent.status === "append_committed",
  );

const proveCycle = async (run: ModelRun) =>
  await executeCorpusProjectionProofCycle({
    runInTransaction: transactionRunner(run.harness),
    client: engineClient(run.harness, PROVER_ENGINE),
    ...TARGET,
    scope: { type: "subjects", entityIds: run.entityIds.map(toLegislationId) },
    afterIndexId: null,
    testNow: await now(run),
  });

/** The index a seeded entity desires, read once before any command moves it. */
const desiredIndexOf = async (entityId: string) =>
  (
    await db
      .select({ indexId: corpusIndexProjectionStates.desiredIndexId })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, entityId))
  ).at(0)?.indexId ?? panic("Seeded entity has no index");

const applyCommand = async (run: ModelRun, next: Command) => {
  const { harness } = run;
  switch (next.type) {
    case "append":
      harness.crash = next.crash;
      harness.transactions = 0;
      await survive(
        async () =>
          await executeCorpusProjectionAppendCycle({
            runInTransaction: transactionRunner(harness),
            client: engineClient(harness, next),
            commitMode: CORPUS_PROJECTION_APPEND_COMMIT_MODE.published,
            ...TARGET,
            scope: {
              type: "subjects",
              entityIds: run.entityIds.map(toLegislationId),
            },
            limit: ENTITIES_PER_RUN,
            fillWindowMs: 600_000,
            payloadReadConcurrency: 2,
            retryDelayMs: 5000,
            payloadRetryLimit: 3,
            unprovenBytesBudget: CORPUS_PROJECTION_UNPROVEN_BYTES_BUDGET_MAX,
            proofAfterIndexId: null,
            payloadReader: async () => Result.ok(PAYLOAD),
          }),
      );
      harness.crash = { type: "none" };
      return;
    case "publish":
      for (const [revision, count] of harness.engine.unpublished) {
        addCount(harness.engine.published, revision, count);
      }
      harness.engine.unpublished.clear();
      return;
    case "lose_unpublished":
      harness.engine.unpublished.clear();
      return;
    case "miscount": {
      const accepted = await acceptedIntentOf(run, next.entity);
      if (
        accepted !== undefined &&
        (harness.engine.published.get(accepted.id) ?? 0) + next.by >= 0
      ) {
        addCount(harness.engine.published, accepted.id, next.by);
      }
      return;
    }
    case "advance":
      run.offsetMs += next.ms;
      return;
    case "prove":
      harness.crash = next.crash;
      harness.transactions = 0;
      await survive(async () => await proveCycle(run));
      harness.crash = { type: "none" };
      return;
    case "double_prove": {
      const accepted = (await readIntents(run.entityIds)).filter(
        ({ status }) => status === "append_committed",
      );
      if (accepted.length === 0) {
        return;
      }
      const census = await proveCorpusProjectionRevisionsPresent({
        client: engineClient(harness, PROVER_ENGINE),
        indexId: run.indexId,
        expected: accepted.map(({ id, expectedDocumentCount }) => ({
          revision: id,
          documentCount:
            expectedDocumentCount ?? panic("Accepted revision has no count"),
        })),
      });
      const value = census.isOk() ? census.value : panic("Census failed");
      const at = await now(run);
      const prove = async () =>
        await db.transaction(
          async (tx) =>
            await proveAcceptedCorpusProjectionAppendsTx(
              asTestRaw<Transaction>(tx),
              {
                indexId: run.indexId,
                census: value,
                timing: PROOF_CYCLE_TIMING,
                testNow: at,
              },
            ),
        );
      const first = await prove();
      const second = await prove();
      // The second prover acts on nothing the first one already decided.
      expect(second.map(({ status }) => status)).toEqual(
        first.map(({ status }) => REPEATED_PROOF[status]),
      );
      return;
    }
    case "change_desired":
      await db
        .update(corpusIndexProjectionStates)
        .set({
          desiredAction: "upsert",
          desiredEpoch: sql`${corpusIndexProjectionStates.desiredEpoch} + 1`,
          desiredFingerprint: "c".repeat(64),
          desiredIndexId: run.indexId,
        })
        .where(
          eq(
            corpusIndexProjectionStates.entityId,
            run.entityIds.at(next.entity) ?? panic("No such entity"),
          ),
        );
      return;
    case "erase": {
      const entityId = run.entityIds.at(next.entity) ?? panic("No such entity");
      await db
        .update(corpusIndexProjectionStates)
        .set({
          desiredAction: "erase",
          desiredEpoch: sql`${corpusIndexProjectionStates.desiredEpoch} + 1`,
          desiredFingerprint: null,
          desiredIndexId: null,
        })
        .where(eq(corpusIndexProjectionStates.entityId, entityId));
      const erasedAt = await now(run);
      await db.transaction(
        async (tx) =>
          await advanceCorpusProjectionErasuresTx(asTestRaw<Transaction>(tx), {
            ...TARGET,
            scope: { type: "subjects", entityIds: [toLegislationId(entityId)] },
            limit: 1,
            testNow: erasedAt,
          }),
      );
      return;
    }
    case "sweep": {
      // The sweep compares leases with the database clock; a lease the
      // virtual clock has passed expires now.
      await db
        .update(corpusIndexProjectionIntents)
        .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(
          and(
            inArray(corpusIndexProjectionIntents.entityId, run.entityIds),
            inArray(corpusIndexProjectionIntents.status, [
              "reserved",
              "append_started",
            ]),
            // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- both sides are database instants, never a round-tripped Date
            sql`${corpusIndexProjectionIntents.leaseExpiresAt} <= ${dbClock.fromNow(run.offsetMs)}`,
          ),
        );
      const sweptAt = await now(run);
      await db.transaction(
        async (tx) =>
          await recoverExpiredCorpusProjectionIntentsTx(
            asTestRaw<Transaction>(tx),
            {
              ...TARGET,
              scope: {
                type: "subjects",
                entityIds: run.entityIds.map(toLegislationId),
              },
              limit: 16,
              testNow: sweptAt,
            },
          ),
      );
      return;
    }
    default:
      next satisfies never;
      panic(`Unhandled model command: ${String(next)}`);
  }
};

const toLegislationId = (entityId: string) =>
  toSafeId<"legislationDocument">(entityId);

type ObservedIntent = Awaited<ReturnType<typeof readIntents>>[number];

/**
 * What must hold after every step, crash or not: an accepted revision holds
 * no lease, a revision became applied only in a step whose census counted it
 * exactly, every applied revision still has exactly its documents, and no
 * entity has more than one revision in flight beside the one it serves.
 */
const assertStepInvariants = async (
  run: ModelRun,
  before: readonly ObservedIntent[],
  step: Command,
) => {
  const intents = await readIntents(run.entityIds);
  const states = await readStates(run.entityIds);
  const statusBefore = new Map(before.map(({ id, status }) => [id, status]));
  for (const intent of intents) {
    if (intent.status === "append_committed") {
      expect(intent.leaseToken).toBeNull();
      expect(intent.appendPublishBarrierAt).not.toBeNull();
    }
    if (intent.status !== "applied") {
      continue;
    }
    if (statusBefore.get(intent.id) !== "applied") {
      expect({
        step: step.type,
        proven: run.harness.engine.censused.get(intent.id),
      }).toEqual({
        step: step.type,
        proven:
          intent.expectedDocumentCount ??
          panic("Applied revision has no count"),
      });
      expect(["append", "prove", "double_prove"]).toContain(step.type);
    }
    expect(run.harness.engine.published.get(intent.id)).toBe(
      intent.expectedDocumentCount ?? panic("Applied revision has no count"),
    );
  }
  for (const state of states) {
    const served = intents.find(({ id }) => id === state.appliedRevision);
    if (state.appliedRevision !== null) {
      expect(served?.entityId).toBe(state.entityId);
    }
    const inFlight = intents.filter(
      ({ entityId, id, status }) =>
        entityId === state.entityId &&
        id !== state.appliedRevision &&
        status !== "settled" &&
        status !== "cancelled",
    );
    expect(inFlight.length).toBeLessThanOrEqual(1);
  }
};

/**
 * Quiescence: every revision whose append was accepted has a decided fate.
 * One still current and exactly published is applied; every other one is
 * cleanup work behind its barrier, with nothing left accepted or started.
 */
const drainAndAssertConverged = async (run: ModelRun) => {
  await applyCommand(run, { type: "publish" });
  run.offsetMs += 30 * 60_000;
  await applyCommand(run, { type: "sweep" });
  await applyCommand(run, { type: "prove", crash: { type: "none" } });
  const intents = await readIntents(run.entityIds);
  const states = await readStates(run.entityIds);
  for (const intent of intents) {
    expect(["applied", "cleanup_pending", "cancelled"]).toContain(
      intent.status,
    );
  }
  for (const state of states) {
    const applied = intents.filter(
      ({ entityId, status }) =>
        entityId === state.entityId && status === "applied",
    );
    expect(applied.length).toBeLessThanOrEqual(1);
    const served = applied.at(0);
    if (served !== undefined) {
      expect(state.appliedRevision).toBe(served.id);
    }
  }
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(corpusIndexGenerations).values({
    ...TARGET,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(MANIFEST),
    status: "building",
  });
  await db.insert(legislationSources).values({
    id: SOURCE_ID,
    adapterKey: "projection-accept-prove-test",
    name: "Projection accept and prove test",
    descriptor: null,
  });
});

afterAll(async () => {
  await client.close();
});

describe("accept, then prove", () => {
  test(
    "every accepted revision converges, applied only through an exact proof, under a crash at any step",
    async () => {
      await assertProperty(
        "every accepted revision converges, applied only through an exact proof, under a crash at any step",
        fc.asyncProperty(
          fc.array(command, { minLength: 1, maxLength: 10 }),
          async (commands) => {
            const entityIds = await seedEntities(ENTITIES_PER_RUN);
            const run: ModelRun = {
              harness: {
                engine: createEngine(),
                crash: { type: "none" },
                transactions: 0,
              },
              entityIds,
              indexId: await desiredIndexOf(
                entityIds.at(0) ?? panic("Model run has no entity"),
              ),
              offsetMs: 0,
            };
            for (const step of commands) {
              const before = await readIntents(run.entityIds);
              run.harness.engine.censused.clear();
              await applyCommand(run, step);
              await assertStepInvariants(run, before, step);
            }
            await drainAndAssertConverged(run);
          },
        ),
        { numRuns: 64 },
      );
    },
    propertyTestTimeout(300_000),
  );
});

type AcceptedFixture = {
  entityId: string;
  intentId: SafeId<"corpusIndexProjectionIntent">;
  indexId: string;
  leaseToken: string;
};

/** Reserve and start one entity's append, as the executor does before its request. */
const startAppend = async (): Promise<AcceptedFixture> => {
  const [entityId] = await seedEntities(1);
  const lease = (
    await db.transaction(
      async (tx) =>
        await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
          ...TARGET,
          scope: {
            type: "subjects",
            entityIds: [toLegislationId(entityId ?? panic("No entity"))],
          },
          limit: 1,
          leaseMs: 5 * 60_000,
        }),
    )
  ).at(0);
  if (lease === undefined || entityId === undefined) {
    return panic("Expected one projection lease");
  }
  expect(
    await db.transaction(
      async (tx) =>
        await startCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: lease.intentId,
          leaseToken: lease.leaseToken,
        }),
    ),
  ).toBe("started");
  return {
    entityId,
    intentId: lease.intentId,
    indexId: lease.indexId,
    leaseToken: lease.leaseToken,
  };
};

const recordAccepted = async (
  fixture: AcceptedFixture,
  overrides: { leaseToken?: string } = {},
) =>
  await db.transaction(
    async (tx) =>
      await recordAcceptedCorpusProjectionAppendsTx(
        asTestRaw<Transaction>(tx),
        {
          accepted: [
            {
              intentId: fixture.intentId,
              leaseToken: overrides.leaseToken ?? fixture.leaseToken,
              documentCount: 2,
            },
          ],
        },
      ),
  );

const censusOf = async (fixture: AcceptedFixture, documents: number) => {
  const census = await proveCorpusProjectionRevisionsPresent({
    client: {
      aggregate: async () =>
        Result.ok({
          projection_revisions: {
            buckets:
              documents === 0
                ? []
                : [{ key: fixture.intentId, doc_count: documents }],
            doc_count_error_upper_bound: 0,
            sum_other_doc_count: 0,
          },
        }),
    },
    indexId: fixture.indexId,
    expected: [{ revision: fixture.intentId, documentCount: 2 }],
  });
  return census.isOk() ? census.value : panic("Census failed");
};

const proveAt = async (
  fixture: AcceptedFixture,
  documents: number,
  testNow?: Date,
  timing: CorpusProjectionProofTiming = PROOF_CYCLE_TIMING,
) =>
  (
    await db.transaction(
      async (tx) =>
        await proveAcceptedCorpusProjectionAppendsTx(
          asTestRaw<Transaction>(tx),
          {
            indexId: fixture.indexId,
            census: await censusOf(fixture, documents),
            timing,
            testNow,
          },
        ),
    )
  ).at(0);

const intentRow = async (fixture: AcceptedFixture) =>
  (
    await db
      .select()
      .from(corpusIndexProjectionIntents)
      .where(eq(corpusIndexProjectionIntents.id, fixture.intentId))
  ).at(0) ?? panic("Missing intent");

const stateRow = async (fixture: AcceptedFixture) =>
  (
    await db
      .select()
      .from(corpusIndexProjectionStates)
      .where(
        and(
          eq(corpusIndexProjectionStates.generation, TARGET.generation),
          eq(corpusIndexProjectionStates.entityId, fixture.entityId),
        ),
      )
  ).at(0) ?? panic("Missing state");

const barrierOf = async (fixture: AcceptedFixture) =>
  (await intentRow(fixture)).appendPublishBarrierAt ??
  panic("Accepted revision has no barrier");

describe("recording an acceptance", () => {
  test("releases the lease and stores the count, the instant and the barrier counted from it", async () => {
    const fixture = await startAppend();
    expect(await recordAccepted(fixture)).toEqual([
      { status: "accepted", intentId: fixture.intentId },
    ]);
    const intent = await intentRow(fixture);
    expect(intent.status).toBe("append_committed");
    expect(intent.leaseToken).toBeNull();
    expect(intent.leaseExpiresAt).toBeNull();
    expect(intent.expectedDocumentCount).toBe(2);
    const acceptedAt = intent.appendCommittedAt ?? panic("No acceptance");
    expect(intent.appendPublishBarrierAt?.getTime()).toBe(
      acceptedAt.getTime() + PUBLISH_DELAY_MS,
    );
  });

  test("is a compare-and-set on the started lease", async () => {
    const fixture = await startAppend();
    expect(
      await recordAccepted(fixture, {
        leaseToken: "0198e331-e578-7000-8000-0000000007ff",
      }),
    ).toEqual([{ status: "lease_lost", intentId: fixture.intentId }]);
    expect((await intentRow(fixture)).status).toBe("append_started");
    await recordAccepted(fixture);
    expect(await recordAccepted(fixture)).toEqual([
      { status: "lease_lost", intentId: fixture.intentId },
    ]);
  });

  test("sends a revision whose desired state moved to cleanup behind its barrier", async () => {
    const fixture = await startAppend();
    await db
      .update(corpusIndexProjectionStates)
      .set({ desiredEpoch: EPOCH + 1n, desiredFingerprint: "d".repeat(64) })
      .where(eq(corpusIndexProjectionStates.entityId, fixture.entityId));
    expect(await recordAccepted(fixture)).toEqual([
      { status: "stale_cleanup_pending", intentId: fixture.intentId },
    ]);
    const intent = await intentRow(fixture);
    expect(intent.status).toBe("cleanup_pending");
    expect(intent.expectedDocumentCount).toBe(2);
    expect(intent.cleanupNotBefore?.getTime()).toBe(
      intent.appendPublishBarrierAt?.getTime(),
    );
  });
});

describe("proving an acceptance", () => {
  test("applies an exactly present revision and its state once its barrier passes, and a second prover finds it applied", async () => {
    const fixture = await startAppend();
    await recordAccepted(fixture);
    const barrier = await barrierOf(fixture);
    // An exact count before the barrier proves nothing yet: documents the
    // engine has not published could still raise it.
    expect(await proveAt(fixture, 2, new Date(barrier.getTime() - 1))).toEqual({
      status: "awaiting_publication",
      intentId: fixture.intentId,
    });
    expect((await intentRow(fixture)).status).toBe("append_committed");
    expect((await stateRow(fixture)).appliedRevision).toBeNull();

    expect(await proveAt(fixture, 2, barrier)).toEqual({
      status: "applied",
      intentId: fixture.intentId,
      entityId: fixture.entityId,
    });
    expect((await stateRow(fixture)).appliedRevision).toBe(fixture.intentId);
    expect(await proveAt(fixture, 2, barrier)).toEqual({
      status: "already_applied",
      intentId: fixture.intentId,
    });
  });

  test("right after a request that waited for publication, applies an exact count at once and retires any other uncharged", async () => {
    const proven = await startAppend();
    await recordAccepted(proven);
    expect(await proveAt(proven, 2, undefined, WAITED_REQUEST)).toEqual({
      status: "applied",
      intentId: proven.intentId,
      entityId: proven.entityId,
    });

    for (const settle of [
      async (fixture: AcceptedFixture) =>
        await proveAt(fixture, 1, undefined, WAITED_REQUEST),
      async (fixture: AcceptedFixture) =>
        (
          await db.transaction(
            async (tx) =>
              await retireAcceptedCorpusProjectionAppendsTx(
                asTestRaw<Transaction>(tx),
                {
                  indexId: fixture.indexId,
                  revisions: [{ revision: fixture.intentId, documentCount: 2 }],
                  failureMessage: WAITED_REQUEST.failureMessage,
                },
              ),
          )
        ).at(0),
    ]) {
      const fixture = await startAppend();
      await recordAccepted(fixture);
      const barrier = await barrierOf(fixture);
      expect(await settle(fixture)).toEqual({
        status: "unproven_cleanup_pending",
        intentId: fixture.intentId,
      });
      const intent = await intentRow(fixture);
      expect(intent.status).toBe("cleanup_pending");
      expect(intent.appendPublishBarrierAt).toEqual(barrier);
      expect(intent.cleanupNotBefore?.getTime()).toBeGreaterThanOrEqual(
        barrier.getTime(),
      );
      const state = await stateRow(fixture);
      expect({
        workStatus: state.workStatus,
        kind: state.lastFailureKind,
        attempts: state.failureAttempts,
        message: state.lastFailureMessage,
      }).toEqual({
        workStatus: "retry_scheduled",
        kind: "append_transient",
        attempts: 0,
        message: WAITED_REQUEST.failureMessage,
      });
    }
  });

  test.each([
    ["absent", 0],
    ["partial", 1],
    ["in excess", 3],
  ] as const)(
    "waits on a revision %s before its deadline, then retires it as unpublished",
    async (_label, documents) => {
      const fixture = await startAppend();
      await recordAccepted(fixture);
      const barrier = await barrierOf(fixture);
      const deadline = new Date(barrier.getTime() + PUBLISH_DELAY_MS);
      expect(
        await proveAt(fixture, documents, new Date(deadline.getTime() - 1)),
      ).toEqual({ status: "awaiting_publication", intentId: fixture.intentId });
      expect((await intentRow(fixture)).status).toBe("append_committed");

      expect(await proveAt(fixture, documents, deadline)).toEqual({
        status: "unproven_cleanup_pending",
        intentId: fixture.intentId,
      });
      const intent = await intentRow(fixture);
      expect(intent.status).toBe("cleanup_pending");
      expect(intent.appendPublishBarrierAt).toEqual(barrier);
      expect(intent.cleanupNotBefore).toEqual(deadline);
      const state = await stateRow(fixture);
      expect(state.appliedRevision).toBeNull();
      expect(state.workStatus).toBe("retry_scheduled");
      expect(state.lastFailureKind).toBe("append_unknown");
      // Sent alone, so the unpublished revision is charged.
      expect(state.failureAttempts).toBe(1);
    },
  );

  test("sends a revision whose desired state moved while it awaited proof to cleanup behind its stored barrier", async () => {
    const fixture = await startAppend();
    await recordAccepted(fixture);
    const barrier = await barrierOf(fixture);
    await db
      .update(corpusIndexProjectionStates)
      .set({ desiredEpoch: EPOCH + 1n, desiredFingerprint: "e".repeat(64) })
      .where(eq(corpusIndexProjectionStates.entityId, fixture.entityId));
    expect(await proveAt(fixture, 2)).toEqual({
      status: "stale_cleanup_pending",
      intentId: fixture.intentId,
    });
    const intent = await intentRow(fixture);
    expect(intent.status).toBe("cleanup_pending");
    expect(intent.appendPublishBarrierAt).toEqual(barrier);
    expect(intent.cleanupNotBefore).toEqual(barrier);
    expect((await stateRow(fixture)).appliedRevision).toBeNull();
  });

  test("leaves a revision an erasure fenced to cleanup, keeping its barrier", async () => {
    const fixture = await startAppend();
    await recordAccepted(fixture);
    const barrier = await barrierOf(fixture);
    await db
      .update(corpusIndexProjectionStates)
      .set({
        desiredAction: "erase",
        desiredEpoch: EPOCH + 1n,
        desiredFingerprint: null,
        desiredIndexId: null,
      })
      .where(eq(corpusIndexProjectionStates.entityId, fixture.entityId));
    await db.transaction(
      async (tx) =>
        await advanceCorpusProjectionErasuresTx(asTestRaw<Transaction>(tx), {
          ...TARGET,
          scope: {
            type: "subjects",
            entityIds: [toLegislationId(fixture.entityId)],
          },
          limit: 1,
        }),
    );
    const fenced = await intentRow(fixture);
    expect(fenced.status).toBe("cleanup_pending");
    expect(fenced.appendPublishBarrierAt).toEqual(barrier);
    expect(await proveAt(fixture, 2)).toEqual({
      status: "not_accepted",
      intentId: fixture.intentId,
    });
  });

  test("claims only accepted revisions whose barrier has passed", async () => {
    const fixture = await startAppend();
    await recordAccepted(fixture);
    const barrier = await barrierOf(fixture);
    const harness: Harness = {
      engine: createEngine(),
      crash: { type: "none" },
      transactions: 0,
    };
    harness.engine.published.set(fixture.intentId, 2);
    const cycle = async (testNow: Date) =>
      await executeCorpusProjectionProofCycle({
        runInTransaction: transactionRunner(harness),
        client: engineClient(harness, PROVER_ENGINE),
        ...TARGET,
        scope: {
          type: "subjects",
          entityIds: [toLegislationId(fixture.entityId)],
        },
        afterIndexId: null,
        testNow,
      });
    const statusOf = async () => (await intentRow(fixture)).status;
    expect(await cycle(new Date(barrier.getTime() - 1))).toEqual({
      status: "idle",
      afterIndexId: null,
    });
    expect(await statusOf()).toBe("append_committed");
    expect(await cycle(barrier)).toMatchObject({
      status: "proved",
      claimed: 1,
      applied: 1,
    });
    expect(await statusOf()).toBe("applied");
  });
});

const appendCycle = async (
  harness: Harness,
  entityIds: readonly string[],
  behavior: IngestBehavior,
) =>
  await executeCorpusProjectionAppendCycle({
    runInTransaction: transactionRunner(harness),
    client: engineClient(harness, behavior),
    commitMode: CORPUS_PROJECTION_APPEND_COMMIT_MODE.published,
    ...TARGET,
    scope: { type: "subjects", entityIds: entityIds.map(toLegislationId) },
    limit: Math.min(entityIds.length, ENTITIES_PER_RUN),
    fillWindowMs: 600_000,
    payloadReadConcurrency: 2,
    retryDelayMs: 5000,
    payloadRetryLimit: 3,
    unprovenBytesBudget: CORPUS_PROJECTION_UNPROVEN_BYTES_BUDGET_MAX,
    proofAfterIndexId: null,
    payloadReader: async () => Result.ok(PAYLOAD),
  });

/** Moves a committed revision's acceptance `agoMs` into the past. */
const acceptedAgo = async (entityIds: readonly string[], agoMs: number) =>
  await db
    .update(corpusIndexProjectionIntents)
    .set({
      appendStartedAt: sql`clock_timestamp() - ${agoMs} * interval '1 millisecond'`,
      appendCommittedAt: sql`clock_timestamp() - ${agoMs} * interval '1 millisecond'`,
      appendPublishBarrierAt: sql`clock_timestamp() - ${agoMs - PUBLISH_DELAY_MS} * interval '1 millisecond'`,
    })
    .where(
      and(
        inArray(corpusIndexProjectionIntents.entityId, [...entityIds]),
        eq(corpusIndexProjectionIntents.status, "append_committed"),
      ),
    );

const NO_CRASH = { type: "none" } as const satisfies CrashPoint;

const freshHarness = (crash: CrashPoint = NO_CRASH): Harness => ({
  engine: createEngine(),
  crash,
  transactions: 0,
});

const statusesOf = async (entityIds: readonly string[]) =>
  (await readIntents(entityIds)).map(({ status }) => status).toSorted();

/**
 * Committed revisions past their barrier for `entityIds`, written directly,
 * with their documents published; `indexId` moves them and their desired
 * state to another index.
 */
const insertProvableRevisions = async (
  harness: Harness,
  entityIds: readonly string[],
  indexId?: string,
) => {
  if (indexId !== undefined) {
    await db
      .update(corpusIndexProjectionStates)
      .set({ desiredIndexId: indexId })
      .where(inArray(corpusIndexProjectionStates.entityId, [...entityIds]));
  }
  const states = await db
    .select()
    .from(corpusIndexProjectionStates)
    .where(inArray(corpusIndexProjectionStates.entityId, [...entityIds]));
  const committedAt = sql`clock_timestamp() - ${PUBLISH_DELAY_MS + 1000} * interval '1 millisecond'`;
  await db.insert(corpusIndexProjectionIntents).values(
    states.map((state) => {
      const id = toSafeId<"corpusIndexProjectionIntent">(Bun.randomUUIDv7());
      harness.engine.published.set(id, 1);
      return {
        id,
        family: state.family,
        generation: state.generation,
        entityId: state.entityId,
        epoch: state.desiredEpoch,
        fingerprint: state.desiredFingerprint ?? panic("No fingerprint"),
        indexId: state.desiredIndexId ?? panic("No index"),
        status: "append_committed" as const,
        appendStartedAt: committedAt,
        appendCommittedAt: committedAt,
        appendPublishBarrierAt: sql`clock_timestamp() - interval '1 second'`,
        appendRequestRevisionCount: 1,
        expectedDocumentCount: 1,
      };
    }),
  );
};

describe("the append cycle converges recorded acceptances", () => {
  test("a revision recorded before a crash is applied by the next append cycle alone", async () => {
    const entityIds = await seedEntities(1);
    const harness = freshHarness({ type: "census" });
    await survive(
      async () =>
        await appendCycle(harness, entityIds, {
          publishOnAccept: true,
          duplicate: false,
        }),
    );
    expect(await statusesOf(entityIds)).toEqual(["append_committed"]);

    await acceptedAgo(entityIds, PUBLISH_DELAY_MS + 1000);
    const next = await appendCycle(harness, entityIds, PROVER_ENGINE);
    expect(next.proof).toMatchObject({
      status: "proved",
      claimed: 1,
      applied: 1,
    });
    expect(next.reserved).toBe(0);
    expect(await statusesOf(entityIds)).toEqual(["applied"]);
  });

  test("a revision absent past its deadline is retired by the next append cycle, and its entity is reserved again once cleanup settles", async () => {
    const entityIds = await seedEntities(1);
    const harness = freshHarness({ type: "census" });
    await survive(
      async () =>
        await appendCycle(harness, entityIds, {
          publishOnAccept: false,
          duplicate: false,
        }),
    );
    harness.engine.unpublished.clear();
    await acceptedAgo(entityIds, 2 * PUBLISH_DELAY_MS + 1000);

    const next = await appendCycle(harness, entityIds, PROVER_ENGINE);
    expect(next.proof).toMatchObject({
      status: "proved",
      claimed: 1,
      retired: 1,
    });
    // Retired in this cycle's proof pass, so not reserved again in it.
    expect(next.reserved).toBe(0);
    expect(await statusesOf(entityIds)).toEqual(["cleanup_pending"]);

    await db
      .update(corpusIndexProjectionIntents)
      .set({
        status: "settled",
        cleanupStartedAt: sql`${corpusIndexProjectionIntents.cleanupNotBefore}`,
        deleteOpstamp: 1n,
        deleteTaskCreatedAt: sql`${corpusIndexProjectionIntents.cleanupNotBefore}`,
        settledAt: sql`${corpusIndexProjectionIntents.cleanupNotBefore}`,
      })
      .where(inArray(corpusIndexProjectionIntents.entityId, entityIds));
    await db
      .update(corpusIndexProjectionStates)
      .set({ retryNotBefore: new Date(0) })
      .where(inArray(corpusIndexProjectionStates.entityId, entityIds));
    const retried = await appendCycle(harness, entityIds, PROVER_ENGINE);
    expect(retried.reserved).toBe(1);
    expect(await statusesOf(entityIds)).toEqual(["applied", "settled"]);
  });

  test("a revision before its barrier is left untouched and keeps its entity out of reservation", async () => {
    const entityIds = await seedEntities(1);
    const harness = freshHarness({ type: "census" });
    await survive(
      async () =>
        await appendCycle(harness, entityIds, {
          publishOnAccept: true,
          duplicate: false,
        }),
    );
    const next = await appendCycle(harness, entityIds, PROVER_ENGINE);
    expect(next.proof).toEqual({ status: "idle", afterIndexId: null });
    expect(next.reserved).toBe(0);
    expect(await statusesOf(entityIds)).toEqual(["append_committed"]);
  });

  test("one proof pass settles at most one census of revisions", async () => {
    const entityIds = await seedEntities(
      CORPUS_PROJECTION_PROOF_CYCLE_MAX_REVISIONS + 1,
    );
    const harness = freshHarness();
    await insertProvableRevisions(harness, entityIds);
    const next = await executeCorpusProjectionProofCycle({
      runInTransaction: transactionRunner(harness),
      client: engineClient(harness, PROVER_ENGINE),
      ...TARGET,
      scope: { type: "subjects", entityIds: entityIds.map(toLegislationId) },
      afterIndexId: null,
    });
    expect(next).toMatchObject({
      status: "proved",
      claimed: CORPUS_PROJECTION_PROOF_CYCLE_MAX_REVISIONS,
      applied: CORPUS_PROJECTION_PROOF_CYCLE_MAX_REVISIONS,
    });
    expect(
      (await statusesOf(entityIds)).filter(
        (status) => status === "append_committed",
      ),
    ).toHaveLength(1);
  });

  test("a failed census in the proof pass settles nothing, is reported, and leaves the append part running", async () => {
    const [seededWaiting, seededEligible] = await seedEntities(2);
    const waiting = seededWaiting ?? panic("Expected two entities");
    const eligible = seededEligible ?? panic("Expected two entities");
    const harness = freshHarness();
    await insertProvableRevisions(harness, [waiting]);
    const indexId = await desiredIndexOf(waiting);
    harness.engine.censusOutages.set(indexId, 1);
    const warn = spyOn(logger, "warn");
    try {
      const cycle = await appendCycle(
        harness,
        [waiting, eligible],
        PROVER_ENGINE,
      );
      expect(cycle.proof).toMatchObject({
        status: "census_failed",
        indexId,
        claimed: 1,
      });
      expect(cycle.status).toBe("engine_unavailable");
      expect(cycle.applied).toBe(1);
      expect(
        warn.mock.calls.filter(
          ([event]) => event === "corpus_projection.engine_unavailable",
        ),
      ).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
    expect(await statusesOf([waiting])).toEqual(["append_committed"]);
    expect(await statusesOf([eligible])).toEqual(["applied"]);

    const healed = await appendCycle(harness, [waiting], PROVER_ENGINE);
    expect(healed.proof).toMatchObject({ status: "proved", applied: 1 });
    expect(await statusesOf([waiting])).toEqual(["applied"]);
  });

  test("passes rotate over indexes, so one whose census keeps failing holds no other back and recovers when the engine does", async () => {
    const [seededFirst, seededSecond] = await seedEntities(2);
    const first = seededFirst ?? panic("Expected two entities");
    const second = seededSecond ?? panic("Expected two entities");
    const harness = freshHarness();
    await insertProvableRevisions(harness, [first]);
    await insertProvableRevisions(harness, [second], "legislation_v2_rotation");
    const failing = await desiredIndexOf(first);
    expect(failing < "legislation_v2_rotation").toBe(true);
    harness.engine.censusOutages.set(failing, 2);
    const pass = async (afterIndexId: string | null) =>
      await executeCorpusProjectionProofCycle({
        runInTransaction: transactionRunner(harness),
        client: engineClient(harness, PROVER_ENGINE),
        ...TARGET,
        scope: {
          type: "subjects",
          entityIds: [first, second].map(toLegislationId),
        },
        afterIndexId,
      });

    const one = await pass(null);
    expect(one).toMatchObject({ status: "census_failed", indexId: failing });
    const two = await pass(one.afterIndexId);
    expect(two).toMatchObject({
      status: "proved",
      indexId: "legislation_v2_rotation",
      applied: 1,
    });
    const three = await pass(two.afterIndexId);
    expect(three).toMatchObject({ status: "census_failed", indexId: failing });
    expect(await statusesOf([first])).toEqual(["append_committed"]);
    const four = await pass(three.afterIndexId);
    expect(four).toMatchObject({
      status: "proved",
      indexId: failing,
      applied: 1,
    });
    expect(await statusesOf([first, second])).toEqual(["applied", "applied"]);
  });
});

const MIGRATION_DIRECTORY = new URL("../../../drizzle/", import.meta.url);

const migrationStatements = async (name: string) =>
  (await Bun.file(new URL(`${name}/migration.sql`, MIGRATION_DIRECTORY)).text())
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) =>
      /^(?:--[^\n]*\n\s*)*(?:ALTER|SET)\b/u.test(statement),
    );

/** One row in each status, written in the shapes the previous check admits. */
const insertRowInEveryStatus = async (entityIds: readonly string[]) => {
  const at = "2026-07-01T00:00:00Z";
  const shapes = [
    `'reserved', gen_random_uuid(), '${at}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL`,
    `'append_started', gen_random_uuid(), '${at}', '${at}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL`,
    // Inside an older writer's apply transaction: lease held, no barrier.
    `'append_committed', gen_random_uuid(), '${at}', '${at}', '${at}', 1, NULL, NULL, NULL, NULL, NULL, NULL, NULL`,
    `'applied', NULL, NULL, '${at}', '${at}', 1, '${at}', NULL, NULL, NULL, NULL, NULL, NULL`,
    `'cleanup_pending', NULL, NULL, '${at}', '${at}', 1, NULL, '${at}', '${at}', NULL, NULL, NULL, NULL`,
    `'cleanup_started', gen_random_uuid(), '${at}', '${at}', NULL, NULL, NULL, '${at}', '${at}', '${at}', NULL, NULL, NULL`,
    `'cleanup_committed', gen_random_uuid(), '${at}', '${at}', NULL, NULL, NULL, '${at}', '${at}', '${at}', 1, '${at}', NULL`,
    `'cleanup_stalled', NULL, NULL, '${at}', NULL, NULL, NULL, '${at}', '${at}', '${at}', 1, '${at}', NULL`,
    `'settled', NULL, NULL, '${at}', NULL, NULL, NULL, '${at}', '${at}', '${at}', 1, '${at}', '${at}'`,
  ];
  for (const [index, shape] of shapes.entries()) {
    const entityId = entityIds.at(index) ?? panic("Not enough entities");
    await db.execute(
      sql.raw(`
        INSERT INTO corpus_index_projection_intents
          (id, family, generation, entity_id, epoch, fingerprint, index_id,
           status, lease_token, lease_expires_at, append_started_at,
           append_committed_at, expected_document_count, applied_at,
           append_publish_barrier_at, cleanup_not_before, cleanup_started_at,
           delete_opstamp, delete_task_created_at, settled_at)
        VALUES
          (gen_random_uuid(), '${TARGET.family}', '${TARGET.generation}',
           '${entityId}', 1, lpad('${index}', 64, '0'), 'legislation_v2_cze',
           ${shape})
      `),
    );
  }
  await db.execute(
    sql.raw(`
      INSERT INTO corpus_index_projection_intents
        (id, family, generation, entity_id, epoch, fingerprint, index_id,
         status, cancelled_at)
      VALUES
        (gen_random_uuid(), '${TARGET.family}', '${TARGET.generation}',
         '${entityIds.at(shapes.length) ?? panic("Not enough entities")}', 1,
         lpad('9', 64, '0'), 'legislation_v2_cze', 'cancelled', '${at}')
    `),
  );
};

describe("the migration over a database at the previous shape", () => {
  test("admits every existing row and an older writer's apply transaction, keeps the reservation arbiter, and carries the new transitions", async () => {
    for (const statement of await migrationStatements(
      "20261003123500_corpus_projection_cleanup_reissue",
    )) {
      if (
        statement.includes('"corpus_index_projection_intents_status_shape"')
      ) {
        await db.execute(sql.raw(statement));
      }
    }
    await insertRowInEveryStatus(await seedEntities(10));
    const olderWriter = await startAppend();

    for (const statement of await migrationStatements(
      "20261114190000_corpus_projection_durable_commit",
    )) {
      await db.execute(sql.raw(statement));
    }
    await db.execute(
      sql`ALTER TABLE corpus_index_projection_intents VALIDATE CONSTRAINT corpus_index_projection_intents_status_shape`,
    );

    // An older writer records the acceptance and applies it in one
    // transaction, holding its lease and storing no barrier.
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE corpus_index_projection_intents
        SET status = 'append_committed', expected_document_count = 2,
            append_committed_at = clock_timestamp()
        WHERE id = ${olderWriter.intentId}
      `);
      await tx.execute(sql`
        UPDATE corpus_index_projection_intents
        SET status = 'applied', applied_at = clock_timestamp(),
            lease_token = NULL, lease_expires_at = NULL
        WHERE id = ${olderWriter.intentId}
      `);
    });
    expect((await intentRow(olderWriter)).status).toBe("applied");

    // Reservation keeps its ON CONFLICT arbiter, and the new transitions run.
    const fixture = await startAppend();
    await recordAccepted(fixture);
    expect(await proveAt(fixture, 2, await barrierOf(fixture))).toMatchObject({
      status: "applied",
    });
  });
});
