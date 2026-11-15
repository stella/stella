import { panic, Result, TaggedError } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";
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
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { readSettledCorpusProjectionCensusPageTx } from "@/api/lib/legal-search/corpus-index-projection-census-store";
import {
  recoverExpiredCorpusProjectionIntentsTx,
  reopenCorpusProjectionCleanupTx,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import {
  CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS,
  type CorpusIndexIntentStatus,
} from "@/api/lib/legal-search/corpus-index-projection-contract";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { legislationProjectionInputFromCanonical } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  corpusProjectionAppendIngestBudgetMs,
  proveCorpusProjectionRevisionsPresent,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import { advanceCorpusProjectionErasuresTx } from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import { executeCorpusProjectionProofCycle } from "@/api/lib/legal-search/corpus-index-projection-prover";
import {
  CORPUS_PROJECTION_OFFLINE_INDEXER_END_MARGIN_MS,
  CORPUS_PROJECTION_OFFLINE_RECORD_MARGIN_MS,
  CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS,
  corpusProjectionOfflineIndexerEndedAt,
  corpusProjectionOfflineIndexerKillDeadline,
} from "@/api/lib/legal-search/corpus-index-projection-publish-fence";
import {
  abandonCorpusProjectionAppendTx,
  CORPUS_PROJECTION_APPEND_UNKNOWN_ATTEMPT_LIMIT,
  CORPUS_PROJECTION_LEASE_MAX_MS,
  type CorpusProjectionIntentLease,
  type CorpusProjectionOfflineRequest,
  type CorpusProjectionOfflineStart,
  proveAcceptedCorpusProjectionAppendsTx,
  readCorpusProjectionOfflineRequestCapsTx,
  readProvableCorpusProjectionAppendsTx,
  recordAcceptedCorpusProjectionAppendsTx,
  reserveCorpusProjectionIntentsTx,
  startCorpusProjectionAppendBatchTx,
  startCorpusProjectionOfflineRequestChunkTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import { corpusProjectionLegacyFixture } from "@/api/tests/helpers/corpus-projection-legacy-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const TARGET = {
  family: "legislation",
  generation: "legislation_v2",
} as const;
const MANIFEST = CORPUS_INDEX_MANIFESTS.legislation_v2;
/** How long an offline run may write: its kill deadline counts from the start. */
const KILL_BUDGET_MS = corpusProjectionAppendIngestBudgetMs(MANIFEST);
/** From the start until no write of the run can still appear. */
const ENDED_AFTER_MS =
  KILL_BUDGET_MS + CORPUS_PROJECTION_OFFLINE_INDEXER_END_MARGIN_MS;
/**
 * The lease a batch takes. A started revision's lease must reach past its
 * request's kill deadline plus the record margin, so the longest lease leaves
 * this much time between reserving and a request's first start.
 */
const LEASE_MS = CORPUS_PROJECTION_LEASE_MAX_MS;
const START_SLACK_MS =
  LEASE_MS - KILL_BUDGET_MS - CORPUS_PROJECTION_OFFLINE_RECORD_MARGIN_MS;
const SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-0000000008f1",
);
const EPOCH = 3n;
const ENTITIES_PER_RUN = 4;
const PAYLOAD_FINGERPRINT = "c".repeat(64);

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let nextDocument = 1;
type TestTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The guard functions and triggers production runs on the projection tables,
 * from the real migrations. The test database is pushed from the schema,
 * which carries the checks but no triggers, so the model runs against both,
 * as production does.
 */
const { installProjectionDdl } = corpusProjectionLegacyFixture(() => db);
const OFFLINE_DELIVERY_MIGRATION_URL = new URL(
  "../../../drizzle/20261115130000_corpus_projection_offline_delivery/migration.sql",
  import.meta.url,
);
const OFFLINE_FAULT_MIGRATION_URL = new URL(
  "../../../drizzle/20261115150000_corpus_projection_offline_fault/migration.sql",
  import.meta.url,
);

type IntentId = SafeId<"corpusIndexProjectionIntent">;

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
        `0198e331-e578-7000-8001-${String(index).padStart(12, "0")}`,
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
      contentHash: "b".repeat(64),
      textS3Key: `test-corpus/offline/${index}`,
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

const toLegislationId = (entityId: string) =>
  toSafeId<"legislationDocument">(entityId);

/** The documents the builder writes for a revision of entity `index`. */
const documentsOf = (entityIndex: number) => (entityIndex % 3) + 1;

/**
 * One offline indexer run over one file, as the engine runs it (pinned by the
 * offline indexer contract tests): a commit publishes whole splits, a
 * revision can straddle a commit boundary and be partly visible, a strict
 * rejection drops a document whatever the exit code, and once the run is
 * killed nothing of it publishes again. A run nobody records keeps going
 * until it exits or its kill deadline.
 */
type IndexerRun = {
  /** The file: started revisions in order, with their documents. */
  file: { revision: IntentId; documents: number }[];
  /** The earliest start of its revisions plus the kill budget. */
  killAt: number;
  ended: "running" | "exited" | "killed";
  /** Documents published so far, per revision, in file order. */
  cursor: number;
  /** Revisions one of whose documents the engine rejects. */
  rejected: Set<IntentId>;
  /** Holds a revision that keeps the whole run from publishing anything. */
  poisoned: boolean;
};

/** What a batch process holds in memory; a crash loses it. */
type BatchMemory = {
  leases: { intentId: IntentId; leaseToken: string; documentCount: number }[];
  run: IndexerRun;
};

type Engine = {
  published: Map<IntentId, number>;
  censused: Map<IntentId, number>;
};

type CrashPoint =
  | { type: "none" }
  | { type: "transaction"; index: number; phase: "before" | "rollback" }
  | { type: "census" };

type Model = {
  entityIds: string[];
  indexId: string;
  offsetMs: number;
  engine: Engine;
  runs: IndexerRun[];
  batches: BatchMemory[];
  crash: CrashPoint;
  transactions: number;
  /** Every status any revision of this run reached. */
  reached: Set<CorpusIndexIntentStatus>;
  /** Entities whose revision keeps any run holding it from publishing. */
  poison: Set<string>;
  /** Indexer runs spawned with each entity's revision in them. */
  deliveries: Map<string, number>;
  /** Entities a step found handed to single requests, the per-row path. */
  everSingle: Set<string>;
};

const crashIf = (model: Model, matches: boolean, at: string) => {
  if (matches) {
    model.crash = { type: "none" };
    throw new SimulatedCrash({ message: `process died at ${at}` });
  }
};

const transactionRunner =
  (model: Model) =>
  async <TResult>(
    operation: (tx: Transaction) => Promise<TResult>,
  ): Promise<TResult> => {
    const index = model.transactions;
    model.transactions += 1;
    const { crash } = model;
    const dies = crash.type === "transaction" && crash.index === index;
    crashIf(model, dies && crash.phase === "before", `transaction ${index}`);
    return await db.transaction(async (tx) => {
      const value = await operation(asTestRaw<Transaction>(tx));
      crashIf(model, dies, `commit of transaction ${index}`);
      return value;
    });
  };

const survive = async (run: () => Promise<unknown>) => {
  const outcome = await Result.tryPromise({
    try: run,
    catch: (cause) => cause,
  });
  if (outcome.isErr() && !SimulatedCrash.is(outcome.error)) {
    throw outcome.error;
  }
};

const engineClient = (model: Model) => ({
  aggregate: async ({ query }: { indexId: string; query: string }) => {
    crashIf(model, model.crash.type === "census", "census");
    const buckets = Array.from(model.engine.published, ([key, count]) => ({
      key,
      doc_count: count,
    })).filter(({ key }) => query.includes(`"${key}"`));
    for (const { key, doc_count } of buckets) {
      model.engine.censused.set(key, doc_count);
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

/** The database clock moved ahead by the model's virtual offset. */
const now = async (model: Model) => {
  const row = (
    await db.execute<{ ms: number }>(
      sql`SELECT (extract(epoch FROM ${dbClock.fromNow(model.offsetMs)}) * 1000)::float8 AS ms`,
    )
  ).rows.at(0);
  return new Date(row?.ms ?? panic("The database returned no clock"));
};

const readIntents = async (entityIds: readonly string[]) =>
  await db
    .select({
      id: corpusIndexProjectionIntents.id,
      entityId: corpusIndexProjectionIntents.entityId,
      status: corpusIndexProjectionIntents.status,
      appendDelivery: corpusIndexProjectionIntents.appendDelivery,
      leaseToken: corpusIndexProjectionIntents.leaseToken,
      appendStartedAt: corpusIndexProjectionIntents.appendStartedAt,
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
      appliedRevision: corpusIndexProjectionStates.appliedRevision,
      workStatus: corpusIndexProjectionStates.workStatus,
      appendMode: corpusIndexProjectionStates.appendMode,
      retryNotBefore: corpusIndexProjectionStates.retryNotBefore,
    })
    .from(corpusIndexProjectionStates)
    .where(inArray(corpusIndexProjectionStates.entityId, [...entityIds]));

/**
 * PGlite has one connection, so the clock is read before a transaction opens:
 * a read from inside one would wait on the transaction it runs in.
 */
const reserve = async (model: Model, limit: number) => {
  const at = await now(model);
  return await transactionRunner(model)(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(tx, {
        ...TARGET,
        scope: {
          type: "subjects",
          entityIds: model.entityIds.map(toLegislationId),
        },
        limit,
        leaseMs: LEASE_MS,
        testNow: at,
      }),
  );
};

/**
 * The shards a batch starts: a lease the per-row path would isolate goes
 * alone; the others are packed in ascending order of their request cap, each
 * shard no larger than the cap of its first, smallest-capped lease.
 */
const shardsOf = async (leases: readonly CorpusProjectionIntentLease[]) => {
  const caps = await db.transaction(
    async (tx) =>
      await readCorpusProjectionOfflineRequestCapsTx(
        asTestRaw<Transaction>(tx),
        leases,
      ),
  );
  const capOf = (lease: CorpusProjectionIntentLease) =>
    caps.get(lease.intentId) ?? panic("A lease has no request cap");
  const shards = leases
    .filter(({ appendMode }) => appendMode === "single")
    .map((lease) => [lease]);
  let rest = leases
    .filter(({ appendMode }) => appendMode === "batchable")
    .toSorted((left, right) => capOf(left) - capOf(right));
  while (rest.length > 0) {
    const cap = capOf(rest[0] ?? panic("No lease to pack"));
    shards.push(rest.slice(0, cap));
    rest = rest.slice(cap);
  }
  return shards;
};

/**
 * Revisions one start transaction of the model takes: below the store's
 * bound, so a request of the model spans several transactions, as a large
 * request does.
 */
const MODEL_START_CHUNK = 2;

/**
 * Start one shard offline, one transaction per chunk, and hand a file of
 * exactly the revisions that started to an indexer. `diesAfterChunks`: the
 * process dies before that many more chunks are started, so the request is
 * left part started, part reserved, and no indexer runs.
 */
const startShard = async (
  model: Model,
  leases: readonly CorpusProjectionIntentLease[],
  spawn: boolean,
  diesAfterChunks: number | null = null,
) => {
  const counts = leases.map((lease) => ({
    lease,
    expectedDocumentCount: documentsOf(model.entityIds.indexOf(lease.entityId)),
  }));
  const request: CorpusProjectionOfflineRequest = {
    requestId: Bun.randomUUIDv7(),
    plannedRevisionCount: counts.length,
  };
  const started: typeof counts = [];
  let requestStartedAt: Date | null = null;
  for (let at = 0; at < counts.length; at += MODEL_START_CHUNK) {
    crashIf(
      model,
      diesAfterChunks !== null && at / MODEL_START_CHUNK >= diesAfterChunks,
      "between the start transactions of one request",
    );
    const chunk = counts.slice(at, at + MODEL_START_CHUNK);
    const startedAt = await now(model);
    const result = await transactionRunner(model)(
      async (tx) =>
        await startCorpusProjectionOfflineRequestChunkTx(tx, {
          request,
          leases: chunk,
          testNow: startedAt,
        }),
    );
    requestStartedAt = result.requestStartedAt ?? requestStartedAt;
    started.push(
      ...chunk.filter(({ lease }) =>
        result.outcomes.some(
          ({ intentId, status }) =>
            intentId === lease.intentId && status === "started",
        ),
      ),
    );
  }
  if (!spawn || started.length === 0 || requestStartedAt === null) {
    return;
  }
  const run: IndexerRun = {
    file: started.map(({ lease, expectedDocumentCount }) => ({
      revision: lease.intentId,
      documents: expectedDocumentCount,
    })),
    killAt: corpusProjectionOfflineIndexerKillDeadline(
      requestStartedAt,
      MANIFEST,
    ).getTime(),
    ended: "running",
    cursor: 0,
    rejected: new Set(),
    poisoned: started.some(({ lease }) => model.poison.has(lease.entityId)),
  };
  for (const { lease } of started) {
    model.deliveries.set(
      lease.entityId,
      (model.deliveries.get(lease.entityId) ?? 0) + 1,
    );
  }
  model.runs.push(run);
  model.batches.push({
    leases: started.map(({ lease, expectedDocumentCount }) => ({
      intentId: lease.intentId,
      leaseToken: lease.leaseToken,
      documentCount: expectedDocumentCount,
    })),
    run,
  });
};

const fileDocuments = (run: IndexerRun) =>
  run.file.flatMap(({ revision, documents }) =>
    Array.from({ length: documents }, (_, index) => ({ revision, index })),
  );

/** Publish the run's file up to document `to`, unless it is past its kill. */
const publishUpTo = async (model: Model, run: IndexerRun, to: number) => {
  if (run.ended !== "running") {
    return;
  }
  if ((await now(model)).getTime() >= run.killAt) {
    run.ended = "killed";
    return;
  }
  const documents = fileDocuments(run);
  for (const { revision, index } of documents.slice(run.cursor, to)) {
    // A strict rejection drops the revision's first document for good; a
    // poisoned run publishes nothing at all.
    if (run.poisoned || (run.rejected.has(revision) && index === 0)) {
      continue;
    }
    model.engine.published.set(
      revision,
      (model.engine.published.get(revision) ?? 0) + 1,
    );
  }
  run.cursor = Math.max(run.cursor, Math.min(to, documents.length));
};

type Command =
  | {
      type: "batch";
      crash:
        | "none"
        | "before_start"
        | "start_rollback"
        | "between_starts"
        | "after_start";
      reject: boolean;
      /** Time between the reservation and the start: the lease runs out first. */
      startDelayMs: number;
    }
  | { type: "indexer_commit"; straddle: boolean }
  | { type: "indexer_exit" }
  /**
   * `early`: the caller records runs it wrongly believes have exited, so the
   * proof cannot lean on that belief.
   */
  | { type: "record"; crash: CrashPoint; early: boolean }
  | { type: "process_crash" }
  | { type: "advance"; ms: number }
  | { type: "sweep" }
  | { type: "prove"; crash: CrashPoint }
  | { type: "late_prove" }
  /** A caller that records before its indexer exits, then a prover. */
  | { type: "early_record_prove" }
  | { type: "change_desired"; entity: number }
  | { type: "erase"; entity: number };

const applyCommand = async (model: Model, next: Command) => {
  model.transactions = 0;
  switch (next.type) {
    case "batch": {
      model.crash =
        next.crash === "start_rollback"
          ? { type: "transaction", index: 1, phase: "rollback" }
          : { type: "none" };
      await survive(async () => {
        const leases = await reserve(model, model.entityIds.length);
        if (next.crash === "before_start") {
          return;
        }
        model.offsetMs += next.startDelayMs;
        const spawn = next.crash !== "after_start";
        for (const shard of await shardsOf(leases)) {
          await startShard(
            model,
            shard,
            spawn,
            next.crash === "between_starts" ? 1 : null,
          );
        }
        if (next.reject) {
          const rejected = model.runs.at(-1)?.file.at(0)?.revision;
          if (rejected !== undefined) {
            model.runs.at(-1)?.rejected.add(rejected);
          }
        }
      });
      model.crash = { type: "none" };
      return;
    }
    case "indexer_commit":
      for (const run of model.runs) {
        const documents = fileDocuments(run);
        if (run.cursor >= documents.length) {
          continue;
        }
        // One commit: through the end of the revision at the cursor, or, if
        // it straddles the boundary, one document short of it.
        let end = run.cursor + 1;
        while (end < documents.length && documents[end]?.index !== 0) {
          end += 1;
        }
        const into = end - run.cursor > 1 ? end - 1 : end;
        await publishUpTo(model, run, next.straddle ? into : end);
      }
      return;
    case "indexer_exit":
      for (const run of model.runs) {
        await publishUpTo(model, run, fileDocuments(run).length);
        if (run.ended === "running") {
          run.ended = "exited";
        }
      }
      return;
    case "record": {
      model.crash = next.crash;
      // The batch records a shard once its child has exited or been killed,
      // whatever its exit code.
      const recordedAt = await now(model);
      const ended = model.batches.filter(
        ({ run }) =>
          next.early ||
          run.ended !== "running" ||
          recordedAt.getTime() >= run.killAt,
      );
      for (const batch of ended) {
        if (
          batch.run.ended === "running" &&
          recordedAt.getTime() >= batch.run.killAt
        ) {
          batch.run.ended = "killed";
        }
      }
      await survive(async () => {
        for (const batch of ended) {
          await transactionRunner(model)(
            async (tx) =>
              await recordAcceptedCorpusProjectionAppendsTx(tx, {
                accepted: batch.leases,
                delivery: {
                  type: "offline_indexer",
                  fault:
                    batch.run.ended === "killed" && batch.leases.length > 1
                      ? "killed"
                      : "documents",
                },
                testNow: recordedAt,
              }),
          );
          model.batches = model.batches.filter((held) => held !== batch);
        }
      });
      model.crash = { type: "none" };
      return;
    }
    case "process_crash":
      // The batch process dies; an indexer it started runs on to its kill.
      model.batches = [];
      return;
    case "advance":
      model.offsetMs += next.ms;
      for (const run of model.runs) {
        if (
          run.ended === "running" &&
          (await now(model)).getTime() >= run.killAt
        ) {
          run.ended = "killed";
        }
      }
      return;
    case "sweep": {
      // The sweep compares leases with the database clock; a lease the
      // virtual clock has passed expires now.
      await db
        .update(corpusIndexProjectionIntents)
        .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
        .where(
          and(
            inArray(corpusIndexProjectionIntents.entityId, model.entityIds),
            inArray(corpusIndexProjectionIntents.status, [
              "reserved",
              "append_started",
            ]),
            // oxlint-disable-next-line no-truncated-timestamp-comparison/no-truncated-timestamp-comparison -- both sides are database instants, never a round-tripped Date
            sql`${corpusIndexProjectionIntents.leaseExpiresAt} <= ${dbClock.fromNow(model.offsetMs)}`,
          ),
        );
      const sweptAt = await now(model);
      await db.transaction(
        async (tx) =>
          await recoverExpiredCorpusProjectionIntentsTx(
            asTestRaw<Transaction>(tx),
            {
              ...TARGET,
              scope: {
                type: "subjects",
                entityIds: model.entityIds.map(toLegislationId),
              },
              limit: 32,
              testNow: sweptAt,
            },
          ),
      );
      return;
    }
    case "prove":
      model.crash = next.crash;
      await survive(
        async () =>
          await executeCorpusProjectionProofCycle({
            runInTransaction: transactionRunner(model),
            client: engineClient(model),
            ...TARGET,
            scope: {
              type: "subjects",
              entityIds: model.entityIds.map(toLegislationId),
            },
            afterIndexId: null,
            testNow: await now(model),
          }),
      );
      model.crash = { type: "none" };
      return;
    case "early_record_prove":
      await applyCommand(model, {
        type: "record",
        crash: { type: "none" },
        early: true,
      });
      await applyCommand(model, { type: "prove", crash: { type: "none" } });
      return;
    case "late_prove": {
      // A census taken while an indexer may still write, acted on only after
      // that indexer has ended: it must not settle what it could not see.
      const readAt = await now(model);
      const provable = await db.transaction(
        async (tx) =>
          await readProvableCorpusProjectionAppendsTx(
            asTestRaw<Transaction>(tx),
            {
              ...TARGET,
              scope: {
                type: "subjects",
                entityIds: model.entityIds.map(toLegislationId),
              },
              afterIndexId: null,
              limit: 32,
              testNow: readAt,
            },
          ),
      );
      if (provable === null) {
        return;
      }
      const census = await proveCorpusProjectionRevisionsPresent({
        client: engineClient(model),
        indexId: provable.indexId,
        expected: provable.revisions,
      });
      await applyCommand(model, { type: "indexer_exit" });
      await applyCommand(model, { type: "advance", ms: ENDED_AFTER_MS });
      const provedAt = await now(model);
      await db.transaction(
        async (tx) =>
          await proveAcceptedCorpusProjectionAppendsTx(
            asTestRaw<Transaction>(tx),
            {
              indexId: provable.indexId,
              census: census.isOk() ? census.value : panic("Census failed"),
              timing: {
                type: "after_barrier",
                censusStart: provable.censusStart,
              },
              testNow: provedAt,
            },
          ),
      );
      return;
    }
    case "change_desired":
    case "erase": {
      const entityId =
        model.entityIds.at(next.entity) ?? panic("No such entity");
      const erase = next.type === "erase";
      await db.transaction(async (tx) => {
        const [document] = await tx
          .update(legislationDocuments)
          .set({
            projectionEpoch: sql`${legislationDocuments.projectionEpoch} + 1`,
          })
          .where(eq(legislationDocuments.id, toLegislationId(entityId)))
          .returning({ epoch: legislationDocuments.projectionEpoch });
        await tx
          .update(corpusIndexProjectionStates)
          .set({
            desiredAction: erase ? "erase" : "upsert",
            desiredEpoch: document?.epoch ?? panic("No canonical row"),
            desiredFingerprint: erase ? null : PAYLOAD_FINGERPRINT,
            desiredIndexId: erase ? null : model.indexId,
            workStatus: "eligible",
            retryNotBefore: null,
            failureAttempts: 0,
            lastFailureKind: null,
            lastFailureMessage: null,
          })
          .where(eq(corpusIndexProjectionStates.entityId, entityId));
      });
      if (erase) {
        const erasedAt = await now(model);
        await db.transaction(
          async (tx) =>
            await advanceCorpusProjectionErasuresTx(
              asTestRaw<Transaction>(tx),
              {
                ...TARGET,
                scope: {
                  type: "subjects",
                  entityIds: [toLegislationId(entityId)],
                },
                limit: 1,
                testNow: erasedAt,
              },
            ),
        );
      }
      return;
    }
    default:
      next satisfies never;
      panic(`Unhandled model command: ${String(next)}`);
  }
};

const crashPoint: fc.Arbitrary<CrashPoint> = fc.oneof(
  fc.constant({ type: "none" } as const),
  fc.record({
    type: fc.constant("transaction" as const),
    index: fc.integer({ min: 0, max: 3 }),
    phase: fc.constantFrom("before" as const, "rollback" as const),
  }),
  fc.constant({ type: "census" } as const),
);
const entity = fc.integer({ min: 0, max: ENTITIES_PER_RUN - 1 });
const advance = fc.record({
  type: fc.constant("advance" as const),
  ms: fc.constantFrom(
    1000,
    KILL_BUDGET_MS / 2,
    ENDED_AFTER_MS,
    LEASE_MS + 1000,
  ),
});

/** Crashes, kills and lost leases, and nothing else: no fault of a document. */
const crashCommand: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      type: fc.constant("batch" as const),
      // Most batches spawn an indexer; the rest die at one of four points.
      crash: fc.oneof(
        { weight: 3, arbitrary: fc.constant("none" as const) },
        {
          weight: 1,
          arbitrary: fc.constantFrom(
            "before_start" as const,
            "start_rollback" as const,
            "between_starts" as const,
            "after_start" as const,
          ),
        },
      ),
      reject: fc.constant(false),
      // Inside the slack the lease allows, or past it: then nothing starts.
      startDelayMs: fc.constantFrom(
        0,
        START_SLACK_MS / 2,
        START_SLACK_MS + 30_000,
      ),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant("indexer_commit" as const),
      straddle: fc.constant(false),
    }),
  },
  { weight: 2, arbitrary: fc.constant({ type: "indexer_exit" } as const) },
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant("record" as const),
      crash: crashPoint,
      early: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ type: "process_crash" } as const) },
  { weight: 3, arbitrary: advance },
  { weight: 2, arbitrary: fc.constant({ type: "sweep" } as const) },
  {
    weight: 3,
    arbitrary: fc.record({
      type: fc.constant("prove" as const),
      crash: crashPoint,
    }),
  },
  { weight: 1, arbitrary: fc.constant({ type: "late_prove" } as const) },
  {
    weight: 2,
    arbitrary: fc.constant({ type: "early_record_prove" } as const),
  },
);

/** Every command, document faults and desired-state changes included. */
const anyCommand: fc.Arbitrary<Command> = fc.oneof(
  { weight: 8, arbitrary: crashCommand },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("batch" as const),
      crash: fc.constant("none" as const),
      reject: fc.constant(true),
      startDelayMs: fc.constant(0),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("indexer_commit" as const),
      straddle: fc.constant(true),
    }),
  },
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
);

/**
 * What must hold after every step, crash or not:
 * - every revision the engine holds has a row (the file holds only started
 *   revisions);
 * - an applied revision holds exactly its documents, and became applied only
 *   in a step whose census counted it exactly;
 * - a withdrawn revision holds no document, now or at any later step;
 * - a committed revision holds no lease and carries its barrier;
 * - no entity has more than one revision in flight beside the one it serves.
 */
const assertStepInvariants = async (
  model: Model,
  before: readonly { id: string; status: string }[],
) => {
  const intents = await readIntents(model.entityIds);
  const states = await readStates(model.entityIds);
  const ids = new Set(intents.map(({ id }) => id));
  for (const revision of model.engine.published.keys()) {
    expect(ids.has(revision)).toBe(true);
  }
  const statusBefore = new Map(before.map(({ id, status }) => [id, status]));
  for (const intent of intents) {
    model.reached.add(intent.status);
    const published = model.engine.published.get(intent.id) ?? 0;
    if (intent.status === "append_committed") {
      expect(intent.leaseToken).toBeNull();
      expect(intent.appendPublishBarrierAt).not.toBeNull();
    }
    if (intent.status === "withdrawn") {
      expect({ withdrawn: intent.id, published }).toEqual({
        withdrawn: intent.id,
        published: 0,
      });
    }
    if (intent.status === "applied") {
      const expected =
        intent.expectedDocumentCount ?? panic("Applied without a count");
      if (statusBefore.get(intent.id) !== "applied") {
        expect(model.engine.censused.get(intent.id)).toBe(expected);
      }
      expect(published).toBe(expected);
    }
  }
  for (const state of states) {
    if (state.appendMode === "single") {
      model.everSingle.add(state.entityId);
    }
    const inFlight = intents.filter(
      ({ entityId, id, status }) =>
        entityId === state.entityId &&
        id !== state.appliedRevision &&
        status !== "settled" &&
        status !== "cancelled" &&
        status !== "withdrawn",
    );
    expect(inFlight.length).toBeLessThanOrEqual(1);
  }
};

const CLEANUP_STATUSES = new Set<CorpusIndexIntentStatus>([
  "cleanup_pending",
  "cleanup_started",
  "cleanup_committed",
  "cleanup_stalled",
  "settled",
]);

/** Run every process to its end and prove what it left, with no crash. */
const settleEverything = async (model: Model) => {
  await applyCommand(model, {
    type: "advance",
    ms: Math.max(ENDED_AFTER_MS, LEASE_MS) + 60_000,
  });
  await applyCommand(model, {
    type: "record",
    crash: { type: "none" },
    early: false,
  });
  await applyCommand(model, { type: "sweep" });
  for (let pass = 0; pass < 3; pass += 1) {
    await applyCommand(model, { type: "prove", crash: { type: "none" } });
  }
};

/** Drive batches with no crash until every entity is served, or give up. */
const drain = async (model: Model) => {
  for (let round = 0; round < 8; round += 1) {
    await settleEverything(model);
    // Past any retry the proofs scheduled.
    model.offsetMs += 10 * 60_000;
    const states = await readStates(model.entityIds);
    if (
      states.every(
        ({ desiredAction, appliedRevision }) =>
          desiredAction === "erase" || appliedRevision !== null,
      )
    ) {
      return;
    }
    await applyCommand(model, {
      type: "batch",
      crash: "none",
      reject: false,
      startDelayMs: 0,
    });
    await applyCommand(model, { type: "indexer_exit" });
    await applyCommand(model, {
      type: "record",
      crash: { type: "none" },
      early: false,
    });
    await applyCommand(model, { type: "prove", crash: { type: "none" } });
  }
};

const newModel = async (
  entityCount: number = ENTITIES_PER_RUN,
): Promise<Model> => {
  const entityIds = await seedEntities(entityCount);
  const indexId =
    (
      await db
        .select({ indexId: corpusIndexProjectionStates.desiredIndexId })
        .from(corpusIndexProjectionStates)
        .where(
          eq(
            corpusIndexProjectionStates.entityId,
            entityIds.at(0) ?? panic("No entity"),
          ),
        )
    ).at(0)?.indexId ?? panic("Seeded entity has no index");
  return {
    entityIds,
    indexId,
    offsetMs: 0,
    engine: { published: new Map(), censused: new Map() },
    runs: [],
    batches: [],
    crash: { type: "none" },
    transactions: 0,
    reached: new Set(),
    poison: new Set(),
    deliveries: new Map(),
    everSingle: new Set(),
  };
};

const runCommands = async (model: Model, commands: readonly Command[]) => {
  for (const step of commands) {
    const before = await readIntents(model.entityIds);
    model.engine.censused.clear();
    await applyCommand(model, step);
    await assertStepInvariants(model, before);
  }
};

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await installProjectionDdl(true);
  await db.insert(corpusIndexGenerations).values({
    ...TARGET,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(MANIFEST),
    status: "building",
  });
  await db.insert(legislationSources).values({
    id: SOURCE_ID,
    adapterKey: "projection-offline-delivery-test",
    name: "Projection offline delivery test",
  });
});

afterAll(async () => {
  await client.close();
});

/** How many runs of a property reached each status: proof it is not vacuous. */
const tally = () => {
  const runs = new Map<CorpusIndexIntentStatus, number>();
  return {
    add: (model: Model) => {
      for (const status of model.reached) {
        runs.set(status, (runs.get(status) ?? 0) + 1);
      }
    },
    of: (status: CorpusIndexIntentStatus) => runs.get(status) ?? 0,
  };
};

describe("offline delivery", () => {
  test(
    "offline delivery converges under a crash at any step with no cleanup",
    async () => {
      const reached = tally();
      await assertProperty(
        "offline delivery converges under a crash at any step with no cleanup",
        fc.asyncProperty(
          fc.array(crashCommand, { minLength: 1, maxLength: 12 }),
          async (commands) => {
            const model = await newModel();
            await runCommands(model, commands);
            await drain(model);
            await assertStepInvariants(
              model,
              await readIntents(model.entityIds),
            );
            reached.add(model);
            const intents = await readIntents(model.entityIds);
            const states = await readStates(model.entityIds);
            // Crashes and kills alone never cost a delete: every revision
            // that started is applied or withdrawn, none waits on cleanup.
            for (const status of model.reached) {
              expect(CLEANUP_STATUSES.has(status)).toBe(false);
            }
            for (const state of states) {
              const served = intents.find(
                ({ id }) => id === state.appliedRevision,
              );
              expect(served?.status).toBe("applied");
            }
            // A refused, killed or crashed delivery never hands an entity to
            // the per-row path: every one stays batched throughout.
            expect([...model.everSingle]).toEqual([]);
            for (const intent of intents) {
              expect(["applied", "withdrawn", "cancelled"]).toContain(
                intent.status,
              );
            }
          },
        ),
        { numRuns: 48 },
      );
      expect(reached.of("withdrawn")).toBeGreaterThan(0);
      expect(reached.of("applied")).toBeGreaterThan(0);
    },
    propertyTestTimeout(600_000),
  );

  test(
    "every offline revision ends decided, and none it gave up holds a document",
    async () => {
      const reached = tally();
      await assertProperty(
        "every offline revision ends decided, and none it gave up holds a document",
        fc.asyncProperty(
          fc.array(anyCommand, { minLength: 1, maxLength: 12 }),
          async (commands) => {
            const model = await newModel();
            await runCommands(model, commands);
            await settleEverything(model);
            await assertStepInvariants(
              model,
              await readIntents(model.entityIds),
            );
            reached.add(model);
            const intents = await readIntents(model.entityIds);
            for (const intent of intents) {
              const published = model.engine.published.get(intent.id) ?? 0;
              // Nothing is left between a start and its proof, and every
              // revision the engine still holds is either served or owed a
              // delete.
              expect([
                "applied",
                "withdrawn",
                "cancelled",
                "cleanup_pending",
              ]).toContain(intent.status);
              if (published > 0) {
                expect(["applied", "cleanup_pending"]).toContain(intent.status);
              }
            }
          },
        ),
        { numRuns: 48 },
      );
      expect(reached.of("withdrawn")).toBeGreaterThan(0);
      expect(reached.of("cleanup_pending")).toBeGreaterThan(0);
    },
    propertyTestTimeout(600_000),
  );
});

/** One entity reserved and started offline, with its lease. */
const startOffline = async (model: Model, documents: number) => {
  const [lease] = await reserve(model, 1);
  if (lease === undefined) {
    return panic("Expected one projection lease");
  }
  const startedAt = await now(model);
  expect(
    (
      await startWholeRequest(
        [{ lease, expectedDocumentCount: documents }],
        startedAt,
      )
    ).outcomes,
  ).toEqual([{ intentId: lease.intentId, status: "started" }]);
  return { lease, startedAt };
};

/** Start a request of at most one transaction's leases in one transaction. */
const startWholeRequest = async (
  leases: readonly {
    lease: CorpusProjectionIntentLease;
    expectedDocumentCount: number;
  }[],
  testNow: Date,
) =>
  await db.transaction(
    async (tx) =>
      await startCorpusProjectionOfflineRequestChunkTx(
        asTestRaw<Transaction>(tx),
        {
          request: {
            requestId: Bun.randomUUIDv7(),
            plannedRevisionCount: leases.length,
          },
          leases,
          testNow,
        },
      ),
  );

const intentOf = async (intentId: IntentId) =>
  (
    await db
      .select()
      .from(corpusIndexProjectionIntents)
      .where(eq(corpusIndexProjectionIntents.id, intentId))
  ).at(0) ?? panic(`No intent ${intentId}`);

const stateOf = async (entityId: string) =>
  (
    await db
      .select()
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, entityId))
  ).at(0) ?? panic(`No state ${entityId}`);

const prove = async (model: Model) =>
  await executeCorpusProjectionProofCycle({
    runInTransaction: transactionRunner(model),
    client: engineClient(model),
    ...TARGET,
    scope: {
      type: "subjects",
      entityIds: model.entityIds.map(toLegislationId),
    },
    afterIndexId: null,
    testNow: await now(model),
  });

/** Every lease's request cap, as a batch would read them now. */
const capsOfPending = async (model: Model) => {
  const leases = await reserve(model, model.entityIds.length);
  const caps = await db.transaction(
    async (tx) =>
      await readCorpusProjectionOfflineRequestCapsTx(
        asTestRaw<Transaction>(tx),
        leases,
      ),
  );
  // Hand the reservations back, as a batch that stops here would.
  model.offsetMs += LEASE_MS + 1000;
  await applyCommand(model, { type: "sweep" });
  return new Map(
    leases.map(({ entityId, intentId }) => [entityId, caps.get(intentId)]),
  );
};

/**
 * One batch with no crash, once every retry the last proof scheduled is due:
 * start, run to exit, record, and prove after the end.
 */
const deliveryRound = async (model: Model) => {
  await runCommands(model, [
    { type: "advance", ms: 10 * 60_000 },
    { type: "batch", crash: "none", reject: false, startDelayMs: 0 },
    { type: "indexer_exit" },
    { type: "record", crash: { type: "none" }, early: false },
    { type: "advance", ms: ENDED_AFTER_MS + 10 * 60_000 },
    { type: "prove", crash: { type: "none" } },
  ]);
};

describe("offline request caps", () => {
  test("a shard whose process died after its start leaves its entities batched and uncharged, and halves nothing", async () => {
    const model = await newModel();
    await runCommands(model, [
      { type: "batch", crash: "after_start", reject: false, startDelayMs: 0 },
      { type: "advance", ms: LEASE_MS + ENDED_AFTER_MS },
      { type: "sweep" },
      { type: "prove", crash: { type: "none" } },
    ]);
    const states = await readStates(model.entityIds);
    // The fixture reaches the boundary: the whole shard was withdrawn.
    expect(
      (await readIntents(model.entityIds)).filter(
        ({ status }) => status === "withdrawn",
      ),
    ).toHaveLength(ENTITIES_PER_RUN);
    for (const state of states) {
      expect(state.appendMode).toBe("batchable");
      expect(state.workStatus).toBe("retry_scheduled");
      expect((await stateOf(state.entityId)).failureAttempts).toBe(0);
    }
    // The sweep committed them as `none`: nothing about their documents is
    // known, so their next request is as large as any.
    for (const intent of await readIntents(model.entityIds)) {
      expect((await intentOf(intent.id)).appendFault).toBe("none");
    }
    model.offsetMs += 60_000;
    const caps = await capsOfPending(model);
    expect([...caps.values()]).toEqual(
      Array.from(
        { length: ENTITIES_PER_RUN },
        () => CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS,
      ),
    );
    await deliveryRound(model);
    for (const state of await readStates(model.entityIds)) {
      expect(state.appliedRevision).not.toBeNull();
    }
    expect([...model.everSingle]).toEqual([]);
  });

  test.each([4, 5, 8])(
    "a revision that keeps its run from publishing is alone and blocked within floor(log2 N) plus the attempt limit, N = %i",
    async (entityCount) => {
      const model = await newModel(entityCount);
      const poisoned = model.entityIds.at(0) ?? panic("No entity");
      model.poison.add(poisoned);
      for (let round = 0; round < 24; round += 1) {
        if ((await stateOf(poisoned)).workStatus === "blocked") {
          break;
        }
        await deliveryRound(model);
      }
      expect((await stateOf(poisoned)).workStatus).toBe("blocked");
      // One shard of N, halved down to one, then charged alone: 18 for 8192.
      expect(model.deliveries.get(poisoned)).toBe(
        Math.floor(Math.log2(entityCount)) +
          CORPUS_PROJECTION_APPEND_UNKNOWN_ATTEMPT_LIMIT,
      );
      for (const entityId of model.entityIds.slice(1)) {
        expect((await stateOf(entityId)).appliedRevision).not.toBeNull();
      }
      expect([...model.everSingle]).toEqual([]);
    },
  );

  test("a withdrawal after a start cut short halves from what was delivered, not from the plan", async () => {
    const model = await newModel();
    await runCommands(model, [
      {
        type: "batch",
        crash: "between_starts",
        reject: false,
        startDelayMs: 0,
      },
    ]);
    // A batch that survived the cut records what started as an indexer run
    // over its documents that published nothing.
    const started = await db
      .select({
        intentId: corpusIndexProjectionIntents.id,
        leaseToken: corpusIndexProjectionIntents.leaseToken,
        documentCount: corpusIndexProjectionIntents.expectedDocumentCount,
      })
      .from(corpusIndexProjectionIntents)
      .where(
        and(
          inArray(corpusIndexProjectionIntents.entityId, model.entityIds),
          eq(corpusIndexProjectionIntents.status, "append_started"),
        ),
      );
    const recordedAt = await now(model);
    await db.transaction(
      async (tx) =>
        await recordAcceptedCorpusProjectionAppendsTx(
          asTestRaw<Transaction>(tx),
          {
            accepted: started.map(
              ({ intentId, leaseToken, documentCount }) => ({
                intentId,
                leaseToken: leaseToken ?? panic("Started without a lease"),
                documentCount:
                  documentCount ?? panic("Started without a count"),
              }),
            ),
            delivery: { type: "offline_indexer", fault: "documents" },
            testNow: recordedAt,
          },
        ),
    );
    await runCommands(model, [
      { type: "advance", ms: LEASE_MS + ENDED_AFTER_MS },
      { type: "sweep" },
      { type: "prove", crash: { type: "none" } },
    ]);
    const withdrawn = (await readIntents(model.entityIds)).filter(
      ({ status }) => status === "withdrawn",
    );
    // The fixture differs on the boundary: two of a planned four started.
    expect(withdrawn).toHaveLength(MODEL_START_CHUNK);
    for (const { id } of withdrawn) {
      expect((await intentOf(id)).appendRequestRevisionCount).toBe(
        ENTITIES_PER_RUN,
      );
    }
    model.offsetMs += 60_000;
    const caps = await capsOfPending(model);
    for (const entityId of model.entityIds) {
      expect(caps.get(entityId)).toBe(
        withdrawn.some((intent) => intent.entityId === entityId)
          ? MODEL_START_CHUNK / 2
          : CORPUS_INDEX_OFFLINE_REQUEST_MAX_REVISIONS,
      );
    }
    expect([...model.everSingle]).toEqual([]);
  });

  test("a start transaction past the start window, or with a lease short of the run, starts nothing and keeps the reservation", async () => {
    const model = await newModel();
    const leases = await reserve(model, ENTITIES_PER_RUN);
    const counts = leases.map((lease) => ({ lease, expectedDocumentCount: 1 }));
    const request: CorpusProjectionOfflineRequest = {
      requestId: Bun.randomUUIDv7(),
      plannedRevisionCount: ENTITIES_PER_RUN,
    };
    const chunk = async (part: typeof counts) => {
      const at = await now(model);
      return await db.transaction(
        async (tx) =>
          await startCorpusProjectionOfflineRequestChunkTx(
            asTestRaw<Transaction>(tx),
            { request, leases: part, testNow: at },
          ),
      );
    };
    const firstAt = await now(model);
    const first = await chunk(counts.slice(0, 2));
    expect(first.outcomes.map(({ status }) => status)).toEqual([
      "started",
      "started",
    ]);
    expect(first.requestStartedAt?.getTime()).toBeGreaterThanOrEqual(
      firstAt.getTime(),
    );
    model.offsetMs += CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS + 1000;
    const late = await chunk(counts.slice(2));
    expect(late.outcomes).toEqual(
      counts.slice(2).map(({ lease }): CorpusProjectionOfflineStart => ({
        intentId: lease.intentId,
        status: "not_started",
        reason: "start_window_closed",
      })),
    );
    // One kill deadline for the request: its first start's.
    expect(late.requestStartedAt).toEqual(first.requestStartedAt);
    for (const { lease } of counts.slice(2)) {
      expect((await intentOf(lease.intentId)).status).toBe("reserved");
    }

    const fresh = await newModel();
    const [lease] = await reserve(fresh, 1);
    if (lease === undefined) {
      panic("Expected one projection lease");
    }
    fresh.offsetMs += START_SLACK_MS + 30_000;
    const startedAt = await now(fresh);
    expect(
      (
        await startWholeRequest(
          [{ lease, expectedDocumentCount: 1 }],
          startedAt,
        )
      ).outcomes,
    ).toEqual([
      {
        intentId: lease.intentId,
        status: "not_started",
        reason: "lease_ends_before_run",
      },
    ]);
    expect((await intentOf(lease.intentId)).status).toBe("reserved");
  });

  test("an offline request larger than a revision's cap is refused at the start", async () => {
    const model = await newModel();
    model.poison.add(model.entityIds.at(0) ?? panic("No entity"));
    model.poison.add(model.entityIds.at(1) ?? panic("No entity"));
    // Both poisoned entities are withdrawn twice, so each may start alone only.
    await deliveryRound(model);
    await deliveryRound(model);
    model.offsetMs += 10 * 60_000;
    const leases = (await reserve(model, ENTITIES_PER_RUN)).filter(
      ({ entityId }) => model.poison.has(entityId),
    );
    expect(leases).toHaveLength(2);
    // The fixture differs on the boundary: together they exceed both caps.
    const caps = await db.transaction(
      async (tx) =>
        await readCorpusProjectionOfflineRequestCapsTx(
          asTestRaw<Transaction>(tx),
          leases,
        ),
    );
    expect([...caps.values()]).toEqual([1, 1]);
    const startedAt = await now(model);
    // Across the whole request: each lease alone fits its transaction, but
    // the planned total of two passes both caps.
    const request: CorpusProjectionOfflineRequest = {
      requestId: Bun.randomUUIDv7(),
      plannedRevisionCount: 2,
    };
    for (const lease of leases) {
      const refused = await rejectionOf(
        db.transaction(
          async (tx) =>
            await startCorpusProjectionOfflineRequestChunkTx(
              asTestRaw<Transaction>(tx),
              {
                request,
                leases: [{ lease, expectedDocumentCount: 1 }],
                testNow: startedAt,
              },
            ),
        ),
      );
      expect(String(refused)).toContain("request cap");
    }
  });

  test("a start transaction holds its request until it commits, and a start past the plan is refused", async () => {
    const model = await newModel();
    const counts = (await reserve(model, ENTITIES_PER_RUN)).map((lease) => ({
      lease,
      expectedDocumentCount: 1,
    }));
    const request: CorpusProjectionOfflineRequest = {
      requestId: Bun.randomUUIDv7(),
      plannedRevisionCount: MODEL_START_CHUNK,
    };
    const startedAt = await now(model);
    const requestLocks = async (tx: TestTransaction) =>
      (
        await tx.execute(sql`
          SELECT count(*)::integer AS held
          FROM pg_locks
          WHERE locktype = 'advisory'
            AND pid = pg_backend_pid()
            AND classid = ${0x0f_10_cc_b7}::oid
            AND objid = hashtext(${request.requestId})::oid
            AND granted
        `)
      ).rows;
    // The lock is taken before the earlier starts are counted, so a second
    // transaction of the request waits for this one and counts its rows. It
    // is the same lock however the caller spells the request's identity.
    const held = await db.transaction(async (tx) => {
      await startCorpusProjectionOfflineRequestChunkTx(
        asTestRaw<Transaction>(tx),
        {
          request: { ...request, requestId: request.requestId.toUpperCase() },
          leases: counts.slice(0, MODEL_START_CHUNK),
          testNow: startedAt,
        },
      );
      return await requestLocks(tx);
    });
    expect(held).toEqual([{ held: 1 }]);
    // A second start of the same request, past its plan, starts nothing.
    const refused = await rejectionOf(
      db.transaction(
        async (tx) =>
          await startCorpusProjectionOfflineRequestChunkTx(
            asTestRaw<Transaction>(tx),
            {
              request,
              leases: counts.slice(MODEL_START_CHUNK, MODEL_START_CHUNK + 1),
              testNow: startedAt,
            },
          ),
      ),
    );
    expect(String(refused)).toContain("more revisions than it planned");
    const started = await db
      .select({ id: corpusIndexProjectionIntents.id })
      .from(corpusIndexProjectionIntents)
      .where(
        eq(corpusIndexProjectionIntents.appendRequestId, request.requestId),
      );
    expect(started).toHaveLength(MODEL_START_CHUNK);
    for (const { lease } of counts.slice(MODEL_START_CHUNK)) {
      expect((await intentOf(lease.intentId)).status).toBe("reserved");
    }
  });

  test("an abandoned offline revision is charged by what its request started, not by its plan", async () => {
    const model = await newModel();
    const [lease] = await reserve(model, 1);
    if (lease === undefined) {
      panic("Expected one projection lease");
    }
    // Planned with three more that never started: it travelled alone.
    const request: CorpusProjectionOfflineRequest = {
      requestId: Bun.randomUUIDv7(),
      plannedRevisionCount: ENTITIES_PER_RUN,
    };
    const startedAt = await now(model);
    await db.transaction(
      async (tx) =>
        await startCorpusProjectionOfflineRequestChunkTx(
          asTestRaw<Transaction>(tx),
          {
            request,
            leases: [{ lease, expectedDocumentCount: 1 }],
            testNow: startedAt,
          },
        ),
    );
    expect((await intentOf(lease.intentId)).appendRequestRevisionCount).toBe(
      ENTITIES_PER_RUN,
    );
    const abandonedAt = await now(model);
    const abandoned = await db.transaction(
      async (tx) =>
        await abandonCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: lease.intentId,
          leaseToken: lease.leaseToken,
          errorMessage: "the indexer refused the document",
          rejection: "definite",
          fault: "document",
          testNow: abandonedAt,
        }),
    );
    expect(abandoned.status).toBe("cleanup_pending");
    const state = await stateOf(lease.entityId);
    // Alone in what was delivered, the fault is its own: charged, not split.
    expect(state.failureAttempts).toBe(1);
    expect(state.appendMode).toBe("batchable");
  });
});

describe("offline settlement", () => {
  test("a record before the indexer exits cannot make a proof withdraw what it then writes", async () => {
    const model = await newModel();
    await runCommands(model, [
      { type: "batch", crash: "none", reject: false, startDelayMs: 0 },
      { type: "early_record_prove" },
      { type: "indexer_exit" },
    ]);
    // The fixture reaches the boundary: the indexer wrote after the record.
    expect(model.engine.published.size).toBeGreaterThan(0);
    expect(model.reached.has("append_committed")).toBe(true);
  });

  test("an expired offline start is proven behind its kill deadline, not cleaned up", async () => {
    const model = await newModel();
    const { lease, startedAt } = await startOffline(model, 2);
    model.offsetMs += LEASE_MS + 1000;
    await applyCommand(model, { type: "sweep" });
    const committed = await intentOf(lease.intentId);
    expect(committed.status).toBe("append_committed");
    expect(committed.leaseToken).toBeNull();
    expect(committed.appendPublishBarrierAt).toEqual(
      corpusProjectionOfflineIndexerEndedAt(startedAt, MANIFEST),
    );
    expect(committed.appendPublishBarrierAt?.getTime()).toBe(
      startedAt.getTime() + ENDED_AFTER_MS,
    );
    // The proof charges what it gives up; the sweep charges nothing.
    expect((await stateOf(lease.entityId)).workStatus).toBe("eligible");

    // An ingest request whose lease expires is still an unknown write.
    const [rest] = await reserve(model, 1);
    if (rest === undefined) {
      panic("Expected a second lease");
    }
    const restStartedAt = await now(model);
    await db.transaction(
      async (tx) =>
        await startCorpusProjectionAppendBatchTx(asTestRaw<Transaction>(tx), {
          leases: [rest],
          testNow: restStartedAt,
        }),
    );
    model.offsetMs += LEASE_MS + 1000;
    await applyCommand(model, { type: "sweep" });
    expect((await intentOf(rest.intentId)).status).toBe("cleanup_pending");
  });

  test("an empty census withdraws an offline revision only once its indexer has ended", async () => {
    const model = await newModel();
    const { lease } = await startOffline(model, 2);
    const recordedAt = await now(model);
    await db.transaction(
      async (tx) =>
        await recordAcceptedCorpusProjectionAppendsTx(
          asTestRaw<Transaction>(tx),
          {
            accepted: [
              {
                intentId: lease.intentId,
                leaseToken: lease.leaseToken,
                documentCount: 2,
              },
            ],
            delivery: { type: "offline_indexer", fault: "documents" },
            testNow: recordedAt,
          },
        ),
    );
    // Recorded at the exit: provable at once, but an empty count is not
    // final while the run could still be writing.
    const early = await prove(model);
    expect(early).toMatchObject({ status: "proved", waiting: 1, withdrawn: 0 });
    expect((await intentOf(lease.intentId)).status).toBe("append_committed");

    model.offsetMs += ENDED_AFTER_MS;
    expect(await prove(model)).toMatchObject({
      status: "proved",
      withdrawn: 1,
      retired: 0,
    });
    const withdrawn = await intentOf(lease.intentId);
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.cleanupNotBefore).toBeNull();

    // No delete owed, no maturity: the entity takes a new revision at the
    // same epoch as soon as its retry is due.
    const state = await stateOf(lease.entityId);
    expect(state.workStatus).toBe("retry_scheduled");
    model.offsetMs += 60_000;
    const again = (await reserve(model, ENTITIES_PER_RUN)).find(
      ({ entityId }) => entityId === lease.entityId,
    );
    expect(again).toBeDefined();
    expect(again?.epoch).toBe(lease.epoch);
    expect(again?.intentId).not.toBe(lease.intentId);
  });

  test("a census dated before the indexer's end never withdraws, however late its proof", async () => {
    const model = await newModel();
    const { lease } = await startOffline(model, 1);
    const recordedAt = await now(model);
    await db.transaction(
      async (tx) =>
        await recordAcceptedCorpusProjectionAppendsTx(
          asTestRaw<Transaction>(tx),
          {
            accepted: [
              {
                intentId: lease.intentId,
                leaseToken: lease.leaseToken,
                documentCount: 1,
              },
            ],
            delivery: { type: "offline_indexer", fault: "documents" },
            testNow: recordedAt,
          },
        ),
    );
    const readAt = await now(model);
    const provable =
      (await db.transaction(
        async (tx) =>
          await readProvableCorpusProjectionAppendsTx(
            asTestRaw<Transaction>(tx),
            {
              ...TARGET,
              scope: {
                type: "subjects",
                entityIds: model.entityIds.map(toLegislationId),
              },
              afterIndexId: null,
              limit: 8,
              testNow: readAt,
            },
          ),
      )) ?? panic("Expected a provable revision");
    expect(provable.censusStart.at).toEqual(readAt);
    const census = await proveCorpusProjectionRevisionsPresent({
      client: engineClient(model),
      indexId: provable.indexId,
      expected: provable.revisions,
    });
    // The fixture differs on the fault boundary: the proof runs after the
    // end, the census it carries did not.
    const provedAt = new Date(readAt.getTime() + ENDED_AFTER_MS + 1000);
    expect(
      corpusProjectionOfflineIndexerEndedAt(
        (await intentOf(lease.intentId)).appendStartedAt ?? panic("No start"),
        MANIFEST,
      ).getTime(),
    ).toBeLessThan(provedAt.getTime());
    const outcomes = await db.transaction(
      async (tx) =>
        await proveAcceptedCorpusProjectionAppendsTx(
          asTestRaw<Transaction>(tx),
          {
            indexId: provable.indexId,
            census: census.isOk() ? census.value : panic("Census failed"),
            timing: {
              type: "after_barrier",
              censusStart: provable.censusStart,
            },
            testNow: provedAt,
          },
        ),
    );
    expect(outcomes).toEqual([
      { status: "awaiting_publication", intentId: lease.intentId },
    ]);
    // Without a dated census, an offline revision is never given up either.
    const undated = await db.transaction(
      async (tx) =>
        await proveAcceptedCorpusProjectionAppendsTx(
          asTestRaw<Transaction>(tx),
          {
            indexId: provable.indexId,
            census: census.isOk() ? census.value : panic("Census failed"),
            timing: { type: "after_barrier" },
            testNow: provedAt,
          },
        ),
    );
    expect(undated).toEqual([
      { status: "awaiting_publication", intentId: lease.intentId },
    ]);
  });

  test.each([
    {
      committedBy: "the indexer's verdict",
      fault: "documents",
      appendMode: "single",
    },
    {
      committedBy: "a kill of the run",
      fault: "killed",
      appendMode: "batchable",
    },
    { committedBy: "the sweep", fault: "none", appendMode: "batchable" },
  ] as const)(
    "a partial offline revision committed by $committedBy goes to cleanup uncharged, its entity $appendMode",
    async ({ fault, appendMode }) => {
      const model = await newModel();
      const leases = await reserve(model, 2);
      const startedAt = await now(model);
      await startWholeRequest(
        leases.map((lease) => ({ lease, expectedDocumentCount: 3 })),
        startedAt,
      );
      const [partial, exact] = leases;
      if (partial === undefined || exact === undefined) {
        panic("Expected two leases");
      }
      model.engine.published.set(partial.intentId, 2);
      model.engine.published.set(exact.intentId, 3);
      if (fault !== "none") {
        const recordedAt = await now(model);
        await db.transaction(
          async (tx) =>
            await recordAcceptedCorpusProjectionAppendsTx(
              asTestRaw<Transaction>(tx),
              {
                accepted: leases.map(({ intentId, leaseToken }) => ({
                  intentId,
                  leaseToken,
                  documentCount: 3,
                })),
                delivery: { type: "offline_indexer", fault },
                testNow: recordedAt,
              },
            ),
        );
      }
      model.offsetMs += LEASE_MS + ENDED_AFTER_MS;
      await applyCommand(model, { type: "sweep" });
      expect((await intentOf(partial.intentId)).appendFault).toBe(fault);
      expect(await prove(model)).toMatchObject({ applied: 1, retired: 1 });
      expect((await intentOf(exact.intentId)).status).toBe("applied");
      expect((await intentOf(partial.intentId)).status).toBe("cleanup_pending");
      // Shared with another, a partial count says only that one of them may
      // be at fault: only a delivery its indexer ran to a verdict isolates
      // the entity, and nobody is charged.
      const state = await stateOf(partial.entityId);
      expect(state.appendMode).toBe(appendMode);
      expect(state.failureAttempts).toBe(0);
    },
  );

  test("the absent census reads withdrawn revisions, and one it observes reopens", async () => {
    const model = await newModel();
    const { lease } = await startOffline(model, 1);
    model.offsetMs += LEASE_MS + ENDED_AFTER_MS;
    await applyCommand(model, { type: "sweep" });
    expect(await prove(model)).toMatchObject({ withdrawn: 1 });
    // The whole absent census of the index, page by page, as the gate walks
    // it: every revision appears once, in order, the withdrawn one with them.
    const walked: string[] = [];
    let after: string | null = null;
    for (;;) {
      const cursor: string | null = after;
      const page: Awaited<
        ReturnType<typeof readSettledCorpusProjectionCensusPageTx>
      > = await db.transaction(
        async (tx) =>
          await readSettledCorpusProjectionCensusPageTx(
            asTestRaw<Transaction>(tx),
            { ...TARGET, indexId: lease.indexId, after: cursor, limit: 16 },
          ),
      );
      walked.push(...page.candidates.map(({ revision }) => revision));
      if (page.complete) {
        break;
      }
      after = page.nextCursor;
    }
    expect(walked).toContain(lease.intentId);
    expect(walked).toEqual([...new Set(walked)].toSorted());
    // An engine that wrote after its kill would be a broken engine fact; the
    // census catches it and the revision takes an exact delete.
    const reopenedAt = await now(model);
    expect(
      await db.transaction(
        async (tx) =>
          await reopenCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
            intentIds: [lease.intentId],
            indexId: lease.indexId,
            errorMessage: "withdrawn revision observed",
            testNow: reopenedAt,
          }),
      ),
    ).toBe(1);
    expect((await intentOf(lease.intentId)).status).toBe("cleanup_pending");
  });

  test("an erasure applies over a withdrawn revision", async () => {
    const model = await newModel();
    const { lease } = await startOffline(model, 1);
    model.offsetMs += LEASE_MS + ENDED_AFTER_MS;
    await applyCommand(model, { type: "sweep" });
    expect(await prove(model)).toMatchObject({ withdrawn: 1 });
    await applyCommand(model, {
      type: "erase",
      entity: model.entityIds.indexOf(lease.entityId),
    });
    expect((await stateOf(lease.entityId)).appliedAction).toBe("erase");
  });
});

describe("offline delivery guards", () => {
  test.each([
    {
      migrationUrl: OFFLINE_DELIVERY_MIGRATION_URL,
      names: [
        "corpus_index_projection_intents_append_delivery_shape",
        "corpus_index_projection_intents_append_delivery_values",
        "corpus_index_projection_intents_status_shape",
        "corpus_index_projection_intents_status_values",
      ],
    },
    {
      migrationUrl: OFFLINE_FAULT_MIGRATION_URL,
      names: [
        "corpus_index_projection_intents_append_fault_shape",
        "corpus_index_projection_intents_append_fault_values",
      ],
    },
  ])(
    "the migration's checks are the ones the schema declares: $names",
    async ({ migrationUrl, names }) => {
      // The test database is pushed from the schema; production gets these
      // checks from the migration. Replace each schema check with the
      // migration's own clause and compare PostgreSQL's reading of both.
      const migration = await Bun.file(migrationUrl).text();
      const clauses = [
        ...migration.matchAll(
          /ADD CONSTRAINT "([a-z_]+)"\s+(CHECK \([\s\S]*?\)) NOT VALID(?=,\s*(?:ADD|DROP) |;)/gu,
        ),
      ].map(([, name, check]) => ({
        name: name ?? panic("A migration check has no name"),
        check: check ?? panic("A migration check has no clause"),
      }));
      expect(clauses.map(({ name }) => name).toSorted()).toEqual([...names]);
      const definitions = async (tx: TestTransaction) =>
        new Map(
          (
            await tx.execute<{ name: string; definition: string }>(sql`
            SELECT conname AS name, pg_get_constraintdef(oid) AS definition
            FROM pg_constraint
            WHERE conrelid = 'corpus_index_projection_intents'::regclass
              AND conname IN (${sql.join(
                clauses.map(({ name }) => sql`${name}`),
                sql`, `,
              )})
          `)
          ).rows.map(({ name, definition }) => [
            name,
            definition.replace(/ NOT VALID$/u, ""),
          ]),
        );
      const compared = await rejectionOf(
        db.transaction(async (tx) => {
          const fromSchema = await definitions(tx);
          await tx.execute(
            sql.raw(
              `ALTER TABLE "corpus_index_projection_intents" ${clauses
                .flatMap(({ name, check }) => [
                  `DROP CONSTRAINT "${name}"`,
                  `ADD CONSTRAINT "${name}" ${check} NOT VALID`,
                ])
                .join(", ")}`,
            ),
          );
          const fromMigration = await definitions(tx);
          expect(fromSchema.size).toBe(clauses.length);
          expect(fromMigration).toEqual(fromSchema);
          // Leave the shared database as the schema pushed it.
          return panic("compared");
        }),
      );
      expect(String(compared)).toContain("compared");
    },
  );

  test("only an offline revision can be withdrawn, and its delivery never changes", async () => {
    const model = await newModel();
    const [lease] = await reserve(model, 1);
    if (lease === undefined) {
      panic("Expected one projection lease");
    }
    const startedAt = await now(model);
    await db.transaction(
      async (tx) =>
        await startCorpusProjectionAppendBatchTx(asTestRaw<Transaction>(tx), {
          leases: [lease],
          testNow: startedAt,
        }),
    );
    const recordedAt = await now(model);
    await db.transaction(
      async (tx) =>
        await recordAcceptedCorpusProjectionAppendsTx(
          asTestRaw<Transaction>(tx),
          {
            accepted: [
              {
                intentId: lease.intentId,
                leaseToken: lease.leaseToken,
                documentCount: 1,
              },
            ],
            delivery: { type: "ingest_api" },
            testNow: recordedAt,
          },
        ),
    );
    const rejected = async (update: Promise<unknown>) =>
      await update.then(
        () => "no rejection",
        (error: unknown) =>
          error instanceof Error
            ? `${error.message} ${String(error.cause)}`
            : String(error),
      );
    expect(
      await rejected(
        db.execute(sql`
          UPDATE corpus_index_projection_intents SET status = 'withdrawn'
          WHERE id = ${lease.intentId}
        `),
      ),
    ).toContain("corpus_index_projection_intents_status_shape");
    expect(
      await rejected(
        db.execute(sql`
          UPDATE corpus_index_projection_intents
          SET append_delivery = 'offline_indexer'
          WHERE id = ${lease.intentId}
        `),
      ),
    ).toContain("corpus index append delivery is immutable once started");
    // An offline start without its document count is not an offline start.
    const [bare] = await reserve(model, 1);
    if (bare === undefined) {
      panic("Expected a second lease");
    }
    expect(
      await rejected(
        db.execute(sql`
          UPDATE corpus_index_projection_intents
          SET status = 'append_started', append_started_at = clock_timestamp(),
              append_delivery = 'offline_indexer'
          WHERE id = ${bare.intentId}
        `),
      ),
    ).toContain("corpus_index_projection_intents_append_delivery_shape");
    // Nor is one without its request's planned total.
    const offlineStart = (total: ReturnType<typeof sql>) => sql`
      UPDATE corpus_index_projection_intents
      SET status = 'append_started', append_started_at = clock_timestamp(),
          append_delivery = 'offline_indexer',
          append_request_id = ${Bun.randomUUIDv7()}::uuid,
          expected_document_count = 1,
          append_request_revision_count = ${total}
      WHERE id = ${bare.intentId}
    `;
    expect(await rejected(db.execute(offlineStart(sql`NULL`)))).toContain(
      "corpus_index_projection_intents_append_delivery_shape",
    );
    expect(await rejected(db.execute(offlineStart(sql`1`)))).toBe(
      "no rejection",
    );
  });
});
