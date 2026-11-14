import { panic, Result, TaggedError } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";
import { Temporal } from "@stll/time";

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
import { repairAppliedCorpusProjectionDriftTx } from "@/api/lib/legal-search/corpus-index-projection-census-store";
import {
  claimCorpusProjectionCleanupSettlementTx,
  claimCorpusProjectionCleanupTx,
  CorpusProjectionCleanupSettlementProof,
  recordCorpusProjectionDeleteTx,
  recoverExpiredCorpusProjectionIntentsTx,
  reissueCorpusProjectionCleanupTx,
  releaseCorpusProjectionCleanupSettlementTx,
  settleCorpusProjectionCleanupTx,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import {
  advanceCorpusProjectionDesiredStateTx,
  legislationProjectionInputFromCanonical,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  CORPUS_PROJECTION_APPEND_COMMIT_MODE,
  corpusIndexAppendPublishDelayMs,
  corpusProjectionRevisionsQuery,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import { advanceCorpusProjectionErasuresTx } from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import { executeCorpusProjectionAppendCycle } from "@/api/lib/legal-search/corpus-index-projection-executor";
import { executeCorpusProjectionProofCycle } from "@/api/lib/legal-search/corpus-index-projection-prover";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The projection's no-hide invariant, model-based over the real stores and
 * their database guards, with a fake engine and a crash at any transaction
 * or engine call: an entity readers were served stays served, by a revision
 * no delete was issued for, until its own erasure or a drift repair; an
 * erased entity is never served its pre-erasure copy; and nothing names a
 * revision outside `applied`, so the claim's legacy branches stay
 * unreachable for state this release writes.
 */

const TARGET = {
  family: "legislation",
  generation: "legislation_v2",
} as const;
const MANIFEST = CORPUS_INDEX_MANIFESTS.legislation_v2;
const PUBLISH_DELAY_MS = corpusIndexAppendPublishDelayMs(MANIFEST);
const SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-0000000009f1",
);
const ENTITIES_PER_RUN = 3;
const PAYLOAD = { text: "A published act.", ast: null } as const;
const DRIZZLE_DIR = new URL("../../../drizzle/", import.meta.url);
/** Long after any delete task a run issues: settlement may count survivors. */
const SETTLEMENT_NOW = Temporal.Instant.from("2100-01-01T00:00:00Z");

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let nextDocument = 1;
let nextContent = 1;

class SimulatedCrash extends TaggedError("SimulatedCrash")<{
  message: string;
}> {}

/** Install the projection guards and triggers the migrations define. */
const installProjectionMigrationDdl = async (): Promise<void> => {
  const migrations = [
    ...new Bun.Glob("*corpus*projection*/migration.sql").scanSync(
      Bun.fileURLToPath(DRIZZLE_DIR),
    ),
  ]
    .filter((migration) => !migration.includes("projection_revision"))
    .toSorted();
  for (const migration of migrations) {
    const text = await Bun.file(new URL(migration, DRIZZLE_DIR)).text();
    for (const statement of text.split("--> statement-breakpoint")) {
      const ddl = statement.trim();
      if (
        /(?:^|\n)\s*CREATE (?:OR REPLACE )?FUNCTION\b/u.test(ddl) ||
        /(?:^|\n)\s*CREATE TRIGGER\b/u.test(ddl)
      ) {
        // db-await-in-loop: DDL applies in migration order
        await db.execute(sql.raw(ddl));
      }
    }
  }
};

/**
 * One clock for every statement: `clock_timestamp()` runs ahead of the real
 * one by an offset the model advances, so leases, barriers and maturity move
 * with the run while process-side lease checks still see time pass.
 */
const installVirtualClock = async (): Promise<void> => {
  for (const statement of [
    "CREATE TABLE public.model_clock (offset_ms double precision NOT NULL)",
    "INSERT INTO public.model_clock VALUES (0)",
    `CREATE OR REPLACE FUNCTION public.clock_timestamp()
      RETURNS timestamptz LANGUAGE sql VOLATILE
      AS $$
        SELECT pg_catalog.clock_timestamp()
          + offset_ms * interval '1 millisecond'
        FROM public.model_clock
      $$`,
    "SET search_path = public, pg_catalog",
  ]) {
    // db-await-in-loop: the clock is installed in order
    await db.execute(sql.raw(statement));
  }
};

const advanceClock = async (ms: number) => {
  await db.execute(
    sql`UPDATE public.model_clock SET offset_ms = offset_ms + ${ms}`,
  );
};

const virtualNow = async (): Promise<Date> => {
  const row = (
    await db.execute<{ now: Date | string }>(
      sql`SELECT clock_timestamp() AS now`,
    )
  ).rows.at(0);
  return new Date(row?.now ?? panic("The model clock is missing"));
};

const contentHash = () => {
  const value = nextContent;
  nextContent += 1;
  return value.toString(16).padStart(64, "0");
};

const seedEntities = async (count: number): Promise<string[]> => {
  const rows = Array.from({ length: count }, () => {
    const index = nextDocument;
    nextDocument += 1;
    return {
      id: toSafeId<"legislationDocument">(
        `0198e331-e578-7000-8000-${String(index).padStart(12, "0")}`,
      ),
      sourceId: SOURCE_ID,
      eli: `eli/cz/sb/2017/${index}`,
      title: `Act ${index}`,
      country: "CZE",
      language: "cs",
      documentType: "act",
      status: "current",
      effectiveDate: "2017-01-01",
      versionValidFrom: "2017-01-01",
      versionValidTo: null,
      contentHash: contentHash(),
      textS3Key: `test-corpus/${index}`,
      projectionEpoch: 1n,
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
        desiredEpoch: 1n,
        desiredFingerprint: descriptor.fingerprint,
        desiredIndexId: descriptor.indexId,
      };
    }),
  );
  return rows.map(({ id }) => String(id));
};

/** What the engine holds, and every revision a delete was ever sent for. */
type FakeEngine = {
  unpublished: Map<string, number>;
  published: Map<string, number>;
  deleted: Set<string>;
  nextOpstamp: number;
};

type CrashPoint =
  | { type: "none" }
  | { type: "transaction"; index: number; phase: "before" | "rollback" }
  | { type: "engine" };

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

const addCount = (counts: Map<string, number>, key: string, by: number) => {
  const next = (counts.get(key) ?? 0) + by;
  if (next === 0) {
    counts.delete(key);
  } else {
    counts.set(key, next);
  }
};

const revisionsIn = (counts: Map<string, number>, query: string) =>
  [...counts].filter(([revision]) => query.includes(`"${revision}"`));

type IngestBehavior = { publishOnAccept: boolean; reject: boolean };

const engineClient = (
  harness: Harness,
  { publishOnAccept, reject }: IngestBehavior,
) => ({
  ingestCommittedBatch: async ({
    ndjson,
  }: {
    ndjson: string;
  }): Promise<Result<void, CorpusIndexError>> => {
    if (reject) {
      return Result.err(
        new CorpusIndexError({ message: "document rejected", status: 400 }),
      );
    }
    for (const line of ndjson.split("\n")) {
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
    crashIf(harness, harness.crash.type === "engine", "ingest receipt");
    return Result.ok(undefined);
  },
  ingestQueuedBatch: async () =>
    panic("Projection append must wait for publication"),
  aggregate: async ({ query }: { indexId: string; query: string }) =>
    Result.ok({
      projection_revisions: {
        buckets: revisionsIn(harness.engine.published, query).map(
          ([key, doc_count]) => ({ key, doc_count }),
        ),
        doc_count_error_upper_bound: 0,
        sum_other_doc_count: 0,
      },
    }),
  deleteByQuery: async (_indexId: string, query: string) => {
    // Revisions are named in the query, published copies go at once, and a
    // copy published later survives the delete, as an opstamp-ordered delete
    // leaves it.
    for (const [revision] of revisionsIn(harness.engine.published, query)) {
      harness.engine.published.delete(revision);
    }
    for (const revision of query.match(/[0-9a-f-]{36}/gu) ?? []) {
      harness.engine.deleted.add(revision);
    }
    crashIf(harness, harness.crash.type === "engine", "delete receipt");
    harness.engine.nextOpstamp += 1;
    return Result.ok({
      opstamp: harness.engine.nextOpstamp,
      createdAt: Temporal.Instant.fromEpochMilliseconds(
        (await virtualNow()).getTime(),
      ),
    });
  },
  readDeleteSettlements: async ({
    tasks,
  }: {
    tasks: readonly { requiredOpstamp: number }[];
  }) =>
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
  search: async ({ query }: { query: string }) =>
    Result.ok({
      numHits: revisionsIn(harness.engine.published, query).reduce(
        (sum, [, count]) => sum + count,
        0,
      ),
      hits: [],
      snippets: [],
    }),
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

type Command =
  | ({ type: "append"; crash: CrashPoint } & IngestBehavior)
  | { type: "publish" }
  | { type: "advance"; ms: number }
  | { type: "prove"; crash: CrashPoint }
  | { type: "change"; entity: number }
  | { type: "erase"; entity: number }
  | { type: "undo_erase"; entity: number }
  | { type: "erasure"; crash: CrashPoint }
  | { type: "cleanup"; crash: CrashPoint }
  | { type: "settle"; crash: CrashPoint }
  | { type: "sweep" }
  | { type: "repair"; entity: number };

const crashPoint: fc.Arbitrary<CrashPoint> = fc.oneof(
  { weight: 6, arbitrary: fc.constant({ type: "none" } as const) },
  fc.record({
    type: fc.constant("transaction" as const),
    index: fc.integer({ min: 0, max: 4 }),
    phase: fc.constantFrom("before" as const, "rollback" as const),
  }),
  fc.constant({ type: "engine" } as const),
);

const entity = fc.integer({ min: 0, max: ENTITIES_PER_RUN - 1 });

const command: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      type: fc.constant("append" as const),
      publishOnAccept: fc.constantFrom(true, true, true, false),
      reject: fc.constantFrom(false, false, false, true),
      crash: crashPoint,
    }),
  },
  { weight: 2, arbitrary: fc.constant({ type: "publish" } as const) },
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant("advance" as const),
      ms: fc.constantFrom(PUBLISH_DELAY_MS + 1000, 30 * 60_000),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant("prove" as const),
      crash: crashPoint,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ type: fc.constant("change" as const), entity }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ type: fc.constant("erase" as const), entity }),
  },
  {
    weight: 1,
    arbitrary: fc.record({ type: fc.constant("undo_erase" as const), entity }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant("erasure" as const),
      crash: crashPoint,
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      type: fc.constant("cleanup" as const),
      crash: crashPoint,
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant("settle" as const),
      crash: crashPoint,
    }),
  },
  { weight: 1, arbitrary: fc.constant({ type: "sweep" } as const) },
  {
    weight: 1,
    arbitrary: fc.record({ type: fc.constant("repair" as const), entity }),
  },
);

type ModelRun = {
  harness: Harness;
  entityIds: string[];
  indexId: string;
  /** Per entity, the canonical epoch its latest erasure was written at. */
  erasedAtEpoch: Map<string, bigint>;
  /** Cleanup claims that took or restored a served revision. */
  servedClaims: number;
};

const scopeOf = (run: ModelRun) => ({
  type: "subjects" as const,
  entityIds: run.entityIds.map((id) => toSafeId<"legislationDocument">(id)),
});

const entityOf = (run: ModelRun, index: number) =>
  run.entityIds.at(index) ?? panic("No such model entity");

/** A canonical write and the desired state it implies, in one transaction. */
const writeCanonical = async (
  entityId: string,
  hash: string | null,
): Promise<bigint> =>
  await db.transaction(async (transaction) => {
    const tx = asTestRaw<Transaction>(transaction);
    await tx
      .update(legislationDocuments)
      .set({ contentHash: hash })
      .where(
        eq(legislationDocuments.id, toSafeId<"legislationDocument">(entityId)),
      );
    const { epoch } = await advanceCorpusProjectionDesiredStateTx(tx, {
      family: "legislation",
      entityId: toSafeId<"legislationDocument">(entityId),
    });
    return epoch;
  });

const readIntents = async (run: ModelRun) =>
  await db
    .select({
      id: corpusIndexProjectionIntents.id,
      entityId: corpusIndexProjectionIntents.entityId,
      status: corpusIndexProjectionIntents.status,
      epoch: corpusIndexProjectionIntents.epoch,
    })
    .from(corpusIndexProjectionIntents)
    .where(inArray(corpusIndexProjectionIntents.entityId, run.entityIds));

const readStates = async (run: ModelRun) =>
  await db
    .select({
      entityId: corpusIndexProjectionStates.entityId,
      desiredAction: corpusIndexProjectionStates.desiredAction,
      appliedAction: corpusIndexProjectionStates.appliedAction,
      appliedRevision: corpusIndexProjectionStates.appliedRevision,
      desiredEpoch: corpusIndexProjectionStates.desiredEpoch,
      workStatus: corpusIndexProjectionStates.workStatus,
    })
    .from(corpusIndexProjectionStates)
    .where(inArray(corpusIndexProjectionStates.entityId, run.entityIds));

/**
 * The database and the engine at one instant. The engine's deletions are
 * copied, so a snapshot taken before a step still tells what was served
 * before it, whatever the step deletes.
 */
type Snapshot = {
  states: Awaited<ReturnType<typeof readStates>>;
  intents: Awaited<ReturnType<typeof readIntents>>;
  deleted: ReadonlySet<string>;
};

const snapshot = async (run: ModelRun): Promise<Snapshot> => ({
  states: await readStates(run),
  intents: await readIntents(run),
  deleted: new Set(run.harness.engine.deleted),
});

/** The revision readers are served for an entity at the snapshot, or null. */
const servedRevision = (
  { states, intents, deleted }: Snapshot,
  entityId: string,
) => {
  const state = states.find((row) => row.entityId === entityId);
  if (
    state?.desiredAction !== "upsert" ||
    state.appliedAction !== "upsert" ||
    state.appliedRevision === null
  ) {
    return null;
  }
  const named = intents.find(({ id }) => id === state.appliedRevision);
  if (named?.status !== "applied" || deleted.has(named.id)) {
    return null;
  }
  return named;
};

const claimCleanup = async (run: ModelRun) => {
  const { harness } = run;
  const runTx = transactionRunner(harness);
  const claim = await runTx(
    async (tx) =>
      await claimCorpusProjectionCleanupTx(tx, {
        ...TARGET,
        scope: scopeOf(run),
        indexId: run.indexId,
        limit: 16,
        leaseMs: 60_000,
      }),
  );
  run.servedClaims +=
    claim.restoredIntentIds.length +
    claim.claimed.served_after_delete +
    claim.claimed.served_unproven;
  const leaseToken = claim.leases.at(0)?.leaseToken;
  if (leaseToken === undefined) {
    return;
  }
  const intentIds = claim.leases.map(({ intentId }) => intentId);
  const receipt = await engineClient(harness, {
    publishOnAccept: true,
    reject: false,
  }).deleteByQuery(run.indexId, corpusProjectionRevisionsQuery(intentIds));
  const task = receipt.isOk() ? receipt.value : panic("Fake delete failed");
  await runTx(
    async (tx) =>
      await recordCorpusProjectionDeleteTx(tx, {
        intentIds,
        indexId: run.indexId,
        leaseToken,
        deleteOpstamp: task.opstamp,
        deleteTaskCreatedAt: task.createdAt,
      }),
  );
};

const settleCleanup = async (run: ModelRun) => {
  const runTx = transactionRunner(run.harness);
  const leases = await runTx(
    async (tx) =>
      await claimCorpusProjectionCleanupSettlementTx(tx, {
        ...TARGET,
        scope: scopeOf(run),
        indexId: run.indexId,
        limit: 16,
        taskLimit: 4,
        leaseMs: 60_000,
      }),
  );
  if (leases.length === 0) {
    return;
  }
  const verdicts = await CorpusProjectionCleanupSettlementProof.verifyAll({
    client: engineClient(run.harness, { publishOnAccept: true, reject: false }),
    indexId: run.indexId,
    leases,
    testNow: SETTLEMENT_NOW,
  });
  for (const { lease, result } of verdicts) {
    const verdict = result.isOk() ? result.value : panic("Settlement failed");
    if (verdict.status === "verified") {
      // db-await-in-loop: each verdict is its own transition
      await runTx(
        async (tx) =>
          await settleCorpusProjectionCleanupTx(tx, { proof: verdict.proof }),
      );
    } else if (verdict.reason === "survivor") {
      await runTx(
        async (tx) =>
          await reissueCorpusProjectionCleanupTx(tx, {
            reissue: verdict.reissue,
          }),
      );
    } else {
      await runTx(
        async (tx) =>
          await releaseCorpusProjectionCleanupSettlementTx(tx, { lease }),
      );
    }
  }
};

const applyCommand = async (run: ModelRun, next: Command) => {
  const { harness } = run;
  harness.transactions = 0;
  switch (next.type) {
    case "append":
      harness.crash = next.crash;
      await survive(
        async () =>
          await executeCorpusProjectionAppendCycle({
            runInTransaction: transactionRunner(harness),
            client: engineClient(harness, next),
            commitMode: CORPUS_PROJECTION_APPEND_COMMIT_MODE.published,
            ...TARGET,
            scope: scopeOf(run),
            limit: ENTITIES_PER_RUN,
            fillWindowMs: 600_000,
            payloadReadConcurrency: 2,
            retryDelayMs: 5000,
            payloadRetryLimit: 3,
            proofAfterIndexId: null,
            payloadReader: async () => Result.ok(PAYLOAD),
          }),
      );
      break;
    case "publish":
      for (const [revision, count] of harness.engine.unpublished) {
        addCount(harness.engine.published, revision, count);
      }
      harness.engine.unpublished.clear();
      break;
    case "advance":
      await advanceClock(next.ms);
      break;
    case "prove":
      harness.crash = next.crash;
      await survive(
        async () =>
          await executeCorpusProjectionProofCycle({
            runInTransaction: transactionRunner(harness),
            client: engineClient(harness, {
              publishOnAccept: true,
              reject: false,
            }),
            ...TARGET,
            scope: scopeOf(run),
            afterIndexId: null,
            testNow: await virtualNow(),
          }),
      );
      break;
    case "change": {
      const entityId = entityOf(run, next.entity);
      const current = (
        await db
          .select({ contentHash: legislationDocuments.contentHash })
          .from(legislationDocuments)
          .where(
            eq(
              legislationDocuments.id,
              toSafeId<"legislationDocument">(entityId),
            ),
          )
      ).at(0);
      // A change keeps an erased entity erased; undoing is its own command.
      if (current?.contentHash !== null) {
        await writeCanonical(entityId, contentHash());
      }
      break;
    }
    case "erase": {
      const entityId = entityOf(run, next.entity);
      run.erasedAtEpoch.set(entityId, await writeCanonical(entityId, null));
      break;
    }
    case "undo_erase": {
      const entityId = entityOf(run, next.entity);
      if (run.erasedAtEpoch.has(entityId)) {
        await writeCanonical(entityId, contentHash());
      }
      break;
    }
    case "erasure":
      harness.crash = next.crash;
      await survive(
        async () =>
          await transactionRunner(harness)(
            async (tx) =>
              await advanceCorpusProjectionErasuresTx(tx, {
                ...TARGET,
                scope: scopeOf(run),
                limit: ENTITIES_PER_RUN,
              }),
          ),
      );
      break;
    case "cleanup":
      harness.crash = next.crash;
      await survive(async () => await claimCleanup(run));
      break;
    case "settle":
      harness.crash = next.crash;
      await survive(async () => await settleCleanup(run));
      break;
    case "sweep":
      await db.transaction(
        async (tx) =>
          await recoverExpiredCorpusProjectionIntentsTx(
            asTestRaw<Transaction>(tx),
            { ...TARGET, scope: scopeOf(run), limit: 16 },
          ),
      );
      break;
    case "repair": {
      const before = await snapshot(run);
      const served = servedRevision(before, entityOf(run, next.entity));
      if (served !== null) {
        // The census found the copy damaged: its documents are gone.
        harness.engine.published.delete(served.id);
        await db.transaction(
          async (tx) =>
            await repairAppliedCorpusProjectionDriftTx(
              asTestRaw<Transaction>(tx),
              {
                ...TARGET,
                indexId: run.indexId,
                revisions: [served.id],
              },
            ),
        );
      }
      break;
    }
    default:
      next satisfies never;
      panic(`Unhandled model command: ${String(next)}`);
  }
  harness.crash = { type: "none" };
};

const repairedEntity = (run: ModelRun, step: Command): string | null =>
  step.type === "repair" ? entityOf(run, step.entity) : null;

/**
 * A desired write that leaves more than one change between the served copy
 * and the desired state retires the copy: an erasure undone in between cannot
 * be ruled out from the epochs alone. One change never does.
 */
const retiredAsUnproven = (
  step: Command,
  servedBefore: { epoch: bigint },
  stateAfter: { appliedRevision: string | null; desiredEpoch: bigint },
) =>
  (step.type === "change" || step.type === "undo_erase") &&
  stateAfter.appliedRevision === null &&
  stateAfter.desiredEpoch >= servedBefore.epoch + 2n;

const assertStepInvariants = (
  run: ModelRun,
  before: Snapshot,
  after: Snapshot,
  step: Command,
) => {
  for (const state of after.states) {
    if (state.appliedRevision === null) {
      continue;
    }
    const named = after.intents.find(({ id }) => id === state.appliedRevision);
    // Nothing names a revision outside `applied`, nor one a delete reached.
    expect({ step: step.type, status: named?.status }).toEqual({
      step: step.type,
      status: "applied",
    });
    expect(run.harness.engine.deleted.has(state.appliedRevision)).toBe(false);
  }
  for (const entityId of run.entityIds) {
    const servedBefore = servedRevision(before, entityId);
    const servedAfter = servedRevision(after, entityId);
    const state = after.states.find((row) => row.entityId === entityId);
    if (
      servedBefore !== null &&
      state?.desiredAction === "upsert" &&
      repairedEntity(run, step) !== entityId &&
      !retiredAsUnproven(step, servedBefore, state)
    ) {
      expect({ step: step.type, served: servedAfter !== null }).toEqual({
        step: step.type,
        served: true,
      });
    }
    const erasedAt = run.erasedAtEpoch.get(entityId);
    if (servedAfter !== null && erasedAt !== undefined) {
      expect(servedAfter.epoch > erasedAt).toBe(true);
    }
  }
  expect(run.servedClaims).toBe(0);
};

/**
 * Quiescence: with the engine published and time past every barrier, cleanup
 * settles, erasures apply and every upsert entity not blocked by failures is
 * served again, the repaired and the undone through a first append.
 */
const drainAndAssertLive = async (run: ModelRun) => {
  for (let round = 0; round < 6; round += 1) {
    // db-await-in-loop: each round runs the phases in order over the model state
    await applyCommand(run, { type: "publish" });
    await applyCommand(run, { type: "advance", ms: 30 * 60_000 });
    await applyCommand(run, { type: "sweep" });
    await applyCommand(run, { type: "prove", crash: { type: "none" } });
    await applyCommand(run, { type: "erasure", crash: { type: "none" } });
    await applyCommand(run, { type: "cleanup", crash: { type: "none" } });
    await applyCommand(run, { type: "settle", crash: { type: "none" } });
    await applyCommand(run, {
      type: "append",
      publishOnAccept: true,
      reject: false,
      crash: { type: "none" },
    });
  }
  const after = await snapshot(run);
  for (const state of after.states) {
    if (state.desiredAction === "erase") {
      expect(state.appliedAction).toBe("erase");
    } else if (state.workStatus !== "blocked") {
      expect(servedRevision(after, state.entityId)).not.toBeNull();
    }
  }
  expect(run.servedClaims).toBe(0);
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await installProjectionMigrationDdl();
  await installVirtualClock();
  await db.insert(corpusIndexGenerations).values({
    ...TARGET,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(MANIFEST),
    status: "building",
  });
  await db.insert(legislationSources).values({
    id: SOURCE_ID,
    adapterKey: "projection-served-copy-test",
    name: "Projection served copy test",
    descriptor: null,
  });
});

afterAll(async () => {
  await client.close();
});

const desiredIndexOf = async (entityId: string) =>
  (
    await db
      .select({ indexId: corpusIndexProjectionStates.desiredIndexId })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, entityId))
  ).at(0)?.indexId ?? panic("Seeded entity has no index");

describe("the copy a projection state serves", () => {
  test(
    "corpus-projection.served-copy-never-deleted",
    async () => {
      await assertProperty(
        "corpus-projection.served-copy-never-deleted",
        fc.asyncProperty(
          fc.array(command, { minLength: 1, maxLength: 24 }),
          async (commands) => {
            const entityIds = await seedEntities(ENTITIES_PER_RUN);
            const run: ModelRun = {
              harness: {
                engine: {
                  unpublished: new Map(),
                  published: new Map(),
                  deleted: new Set(),
                  nextOpstamp: 0,
                },
                crash: { type: "none" },
                transactions: 0,
              },
              entityIds,
              indexId: await desiredIndexOf(
                entityIds.at(0) ?? panic("Model run has no entity"),
              ),
              erasedAtEpoch: new Map(),
              servedClaims: 0,
            };
            // Every run starts with its entities served, the state the
            // invariant is about; the commands then move them anywhere.
            await applyCommand(run, {
              type: "append",
              publishOnAccept: true,
              reject: false,
              crash: { type: "none" },
            });
            let before = await snapshot(run);
            expect(
              run.entityIds.every((id) => servedRevision(before, id) !== null),
            ).toBe(true);
            for (const step of commands) {
              await applyCommand(run, step);
              const after = await snapshot(run);
              assertStepInvariants(run, before, after, step);
              before = after;
            }
            await drainAndAssertLive(run);
          },
        ),
        { numRuns: 100 },
      );
    },
    propertyTestTimeout(600_000),
  );
});

/** The revision a never-erased entity's state serves, after one full append. */
const servedFixture = async () => {
  const [entityId] = await seedEntities(1);
  const run: ModelRun = {
    harness: {
      engine: {
        unpublished: new Map(),
        published: new Map(),
        deleted: new Set(),
        nextOpstamp: 0,
      },
      crash: { type: "none" },
      transactions: 0,
    },
    entityIds: [entityId ?? panic("No entity")],
    indexId: await desiredIndexOf(entityId ?? panic("No entity")),
    erasedAtEpoch: new Map(),
    servedClaims: 0,
  };
  await applyCommand(run, {
    type: "append",
    publishOnAccept: true,
    reject: false,
    crash: { type: "none" },
  });
  const served = servedRevision(await snapshot(run), entityOf(run, 0));
  if (served === null) {
    return panic("Expected the fixture entity to be served");
  }
  return { run, entityId: served.entityId, revision: served.id };
};

const stateOf = async (entityId: string) =>
  (
    await db
      .select({
        desiredAction: corpusIndexProjectionStates.desiredAction,
        appliedAction: corpusIndexProjectionStates.appliedAction,
        appliedRevision: corpusIndexProjectionStates.appliedRevision,
        workStatus: corpusIndexProjectionStates.workStatus,
      })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, entityId))
  ).at(0) ?? panic("No such state");

const statusOf = async (revision: SafeId<"corpusIndexProjectionIntent">) =>
  (
    await db
      .select({ status: corpusIndexProjectionIntents.status })
      .from(corpusIndexProjectionIntents)
      .where(eq(corpusIndexProjectionIntents.id, revision))
  ).at(0)?.status;

describe("transitions that stop serving", () => {
  test("a replacement waits, served at its current revision", async () => {
    const { run, entityId, revision } = await servedFixture();
    await writeCanonical(entityId, contentHash());
    await applyCommand(run, {
      type: "append",
      publishOnAccept: true,
      reject: false,
      crash: { type: "none" },
    });
    await applyCommand(run, { type: "cleanup", crash: { type: "none" } });
    expect(await stateOf(entityId)).toMatchObject({
      desiredAction: "upsert",
      appliedAction: "upsert",
      appliedRevision: revision,
    });
    expect(await statusOf(revision)).toBe("applied");
    expect(run.harness.engine.deleted.size).toBe(0);
  });

  test("an erasure hides at once, and its undo appends anew", async () => {
    const { run, entityId, revision } = await servedFixture();
    await writeCanonical(entityId, null);
    // Readers stop at the desired erasure; the erasure claim un-names it.
    expect(await stateOf(entityId)).toMatchObject({ desiredAction: "erase" });
    await applyCommand(run, { type: "erasure", crash: { type: "none" } });
    expect(await stateOf(entityId)).toMatchObject({
      appliedAction: null,
      appliedRevision: null,
    });
    expect(await statusOf(revision)).toBe("cleanup_pending");

    await writeCanonical(entityId, contentHash());
    expect(await stateOf(entityId)).toMatchObject({
      desiredAction: "upsert",
      appliedRevision: null,
    });
    await drainAndAssertLive(run);
    const served = await stateOf(entityId);
    expect(served.appliedRevision).not.toBe(revision);
    expect(await statusOf(revision)).toBe("settled");
  });

  test("an erasure undone before the erasure claim never restores the old copy", async () => {
    const { entityId, revision } = await servedFixture();
    await writeCanonical(entityId, null);
    await writeCanonical(entityId, contentHash());
    expect(await stateOf(entityId)).toMatchObject({
      desiredAction: "upsert",
      appliedAction: null,
      appliedRevision: null,
    });
    expect(await statusOf(revision)).toBe("cleanup_pending");
  });

  test("a failed re-append after drift repair leaves the entity queued", async () => {
    const { run, entityId, revision } = await servedFixture();
    await applyCommand(run, { type: "repair", entity: 0 });
    expect(await stateOf(entityId)).toMatchObject({
      appliedAction: null,
      appliedRevision: null,
      workStatus: "repair_scheduled",
    });
    await applyCommand(run, { type: "advance", ms: 30 * 60_000 });
    await applyCommand(run, { type: "cleanup", crash: { type: "none" } });
    await applyCommand(run, { type: "settle", crash: { type: "none" } });
    expect(await statusOf(revision)).toBe("settled");
    await applyCommand(run, {
      type: "append",
      publishOnAccept: true,
      reject: true,
      crash: { type: "none" },
    });
    const failed = await stateOf(entityId);
    // The failure overwrote `repair_scheduled`, and the entity still needs
    // work: nothing names a copy that would make applied equal desired.
    expect(failed.workStatus).not.toBe("repair_scheduled");
    expect(failed.appliedAction).toBeNull();
    await drainAndAssertLive(run);
  });
});
