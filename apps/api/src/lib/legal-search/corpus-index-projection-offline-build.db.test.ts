import { panic, Result, TaggedError } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
import { toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import type { CorpusIndexIntentStatus } from "@/api/lib/legal-search/corpus-index-projection-contract";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { legislationProjectionInputFromCanonical } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  buildCorpusProjectionRouteOffline,
  type CorpusProjectionOfflineAdmission,
  type CorpusProjectionOfflineBuildLock,
  type CorpusProjectionOfflineBuildLockHold,
  type CorpusProjectionOfflineBuildOutcome,
  type CorpusProjectionOfflineBuildProgress,
  type CorpusProjectionOfflineDelivery,
  type CorpusProjectionOfflineDeliveryOutcome,
  type CorpusProjectionOfflineShard,
  type CorpusProjectionOfflineWorkUnit,
  requireFreshReadCommittedStartTx,
} from "@/api/lib/legal-search/corpus-index-projection-offline-build";
import {
  CORPUS_PROJECTION_OFFLINE_DEFAULT_INGEST_BYTES_PER_SECOND,
  CORPUS_PROJECTION_OFFLINE_DEFAULT_MAX_SHARD_BYTES,
  type CorpusProjectionOfflineBuildPolicy,
  planCorpusProjectionOfflineBuild,
} from "@/api/lib/legal-search/corpus-index-projection-offline-plan";
import {
  CORPUS_PROJECTION_OFFLINE_INDEXER_END_MARGIN_MS,
  CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS,
} from "@/api/lib/legal-search/corpus-index-projection-publish-fence";
import {
  type CorpusProjectionIntentLease,
  readCorpusProjectionOfflineRequestCapsTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import { corpusProjectionLegacyFixture } from "@/api/tests/helpers/corpus-projection-legacy-fixture";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The offline route build as a whole, against real projection rows and a
 * fake offline indexer whose behaviour follows the engine facts the offline
 * indexer contract tests pin: a run publishes whole splits, so a kill before
 * its publish leaves nothing and a kill after it leaves every document; a
 * strict rejection drops a document whatever the exit code; and a path the
 * indexer has finished is skipped whatever it holds. A process death can
 * land on any transaction or around a delivery, and a later run converges
 * what it left with no manual step.
 */

const TARGET = {
  family: "legislation",
  generation: "legislation_v2",
} as const;
const MANIFEST = CORPUS_INDEX_MANIFESTS.legislation_v2;
const SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-0000000008f2",
);
const ENTITIES = 6;
const SHARD_REVISIONS = 2;

const POLICY = {
  slots: 1,
  ingestBytesPerSecond:
    CORPUS_PROJECTION_OFFLINE_DEFAULT_INGEST_BYTES_PER_SECOND,
  maxShardBytes: CORPUS_PROJECTION_OFFLINE_DEFAULT_MAX_SHARD_BYTES,
  maxShardRevisions: SHARD_REVISIONS,
  fillWindowMs: 60_000,
  closeAllowanceMs: 30_000,
  proofAllowanceMs: 60_000,
  payloadReadConcurrency: 2,
  retryDelayMs: 1000,
  payloadRetryLimit: 3,
} satisfies CorpusProjectionOfflineBuildPolicy;
const PLAN = planCorpusProjectionOfflineBuild(MANIFEST, POLICY);
/** Long enough for every shard of a model and its proof. */
const RUN_MS = PLAN.stopReservingBeforeMs + 4 * 60 * 60_000;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let shardDirectory: string;
let nextDocument = 1;

/**
 * The guard functions and triggers production runs on the projection tables,
 * from the real migrations: the test database is pushed from the schema,
 * which carries the checks but no triggers.
 */
const { installProjectionDdl } = corpusProjectionLegacyFixture(() => db);

/** A process death at one exact point; nothing after it runs. */
class SimulatedCrash extends TaggedError("SimulatedCrash")<{
  message: string;
}> {}

/**
 * How the fake indexer treats one shard:
 * - `ingest`: publishes every document, exits zero;
 * - `reject`: drops one document of the first revision, exits zero or not;
 * - `kill_before_publish` / `kill_after_publish`: killed at the deadline,
 *   with none or all of its split published;
 * - `refuse`: the shard reached the indexer after its kill deadline;
 * - `empty`: the indexer failed on what the file held and published nothing;
 * - `broken`: the indexer could not run (an engine outage), published nothing;
 * - `throw`: the caller's delivery rejected, its indexer possibly running;
 * - `crash_before` / `crash_after_publish`: the batch process dies while
 *   the shard is delivered, before the indexer ran or after it published.
 */
type Delivery =
  | "ingest"
  | { reject: { exitCode: 0 | 1 } }
  | "kill_before_publish"
  | "kill_after_publish"
  | "refuse"
  | "empty"
  | "broken"
  | "throw"
  | "crash_before"
  | "crash_after_publish";

type CrashPoint =
  | { type: "none" }
  | { type: "transaction"; index: number; phase: "before" | "rollback" };

type Model = {
  entityIds: string[];
  offsetMs: number;
  /** Documents the engine holds per revision. */
  published: Map<string, number>;
  /** Paths the indexer finished: it never reads one again. */
  finishedPaths: Set<string>;
  shards: CorpusProjectionOfflineShard[];
  crash: CrashPoint;
  transactions: number;
  lockHeld: boolean;
  /**
   * Entities whose revision keeps any run it is in from publishing, as a
   * document the engine cannot index might.
   */
  poisoned: Set<string>;
  /** The shard size of the run in progress. */
  maxShardRevisions: number;
  /** Every delivery: how many revisions, and whether a poisoned one. */
  deliveries: { revisions: number; poisoned: boolean }[];
  reached: Set<CorpusIndexIntentStatus>;
  /** Every transaction opens in repeatable read, as a misconfigured caller's. */
  repeatableRead: boolean;
  /**
   * After the first transaction that leaves a revision reserved, its entity
   * switches to single delivery, as a retirement of a shared delivery does.
   */
  switchToSingleAfterReserve: boolean;
  switchedToSingle: string | null;
  /** The process died: its clock stops, it sleeps no more. */
  dead: boolean;
  /** Inside one request's start admission: transactions there are starts. */
  inStartAdmission: boolean;
  /** Start transactions of the run so far, across its requests. */
  startTransactions: number;
  /** The process dies right before the start transaction of this index. */
  dieBeforeStartTransaction: number | null;
  /** The start transaction of this index waits this long first. */
  holdStartTransaction: { index: number; ms: number } | null;
  /** When the run let go of its route lock, on the run's clock. */
  lockReleasedAt: Date | null;
};

const crashIf = (model: Model, matches: boolean, at: string) => {
  if (matches) {
    model.crash = { type: "none" };
    model.dead = true;
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
    const start = model.inStartAdmission ? model.startTransactions : null;
    if (start !== null) {
      model.startTransactions += 1;
      crashIf(
        model,
        model.dieBeforeStartTransaction === start,
        `before start transaction ${start}`,
      );
    }
    const value = await db.transaction(async (tx) => {
      if (model.repeatableRead) {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      }
      const result = await operation(asTestRaw<Transaction>(tx));
      crashIf(model, dies, `commit of transaction ${index}`);
      return result;
    });
    // The next start transaction is held back: its statement instant, read
    // before it opens, falls that much later.
    if (start !== null && model.holdStartTransaction?.index === start + 1) {
      model.offsetMs += model.holdStartTransaction.ms;
    }
    if (model.switchToSingleAfterReserve) {
      const reserved = await entityIn(model, "reserved");
      if (reserved !== undefined) {
        model.switchToSingleAfterReserve = false;
        model.switchedToSingle = reserved;
        await db.execute(
          sql`UPDATE ${corpusIndexProjectionStates}
            SET append_mode = 'single'
            WHERE entity_id = ${reserved}`,
        );
      }
    }
    return value;
  };

/** The database clock moved ahead by the model's virtual offset. */
const now = async (model: Model) => {
  const row = (
    await db.execute<{ ms: number }>(
      sql`SELECT (extract(epoch FROM ${dbClock.fromNow(model.offsetMs)}) * 1000)::float8 AS ms`,
    )
  ).rows.at(0);
  return new Date(row?.ms ?? panic("The database returned no clock"));
};

const seedEntities = async (count: number) => {
  const rows = Array.from({ length: count }, () => {
    const index = nextDocument;
    nextDocument += 1;
    return {
      id: toSafeId<"legislationDocument">(
        `0198e331-e578-7000-8002-${String(index).padStart(12, "0")}`,
      ),
      sourceId: SOURCE_ID,
      eli: `eli/cz/sb/2018/${index}`,
      title: `Act ${index}`,
      country: "CZE",
      language: "cs",
      documentType: "act",
      status: "current",
      effectiveDate: "2018-01-01",
      versionValidFrom: "2018-01-01",
      versionValidTo: null,
      contentHash: "d".repeat(64),
      textS3Key: `test-corpus/offline-build/${index}`,
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

const readIntents = async (entityIds: readonly string[]) =>
  await db
    .select({
      id: corpusIndexProjectionIntents.id,
      entityId: corpusIndexProjectionIntents.entityId,
      status: corpusIndexProjectionIntents.status,
      appendDelivery: corpusIndexProjectionIntents.appendDelivery,
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
      appliedRevision: corpusIndexProjectionStates.appliedRevision,
      appendMode: corpusIndexProjectionStates.appendMode,
      workStatus: corpusIndexProjectionStates.workStatus,
      failureAttempts: corpusIndexProjectionStates.failureAttempts,
    })
    .from(corpusIndexProjectionStates)
    .where(inArray(corpusIndexProjectionStates.entityId, [...entityIds]));

/** One projection revision per document line of a shard file. */
const linesOf = async (shard: CorpusProjectionOfflineShard) =>
  (await readFile(shard.path, "utf-8"))
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      const revision =
        typeof parsed === "object" && parsed !== null
          ? Reflect.get(parsed, "projection_revision")
          : undefined;
      return typeof revision === "string"
        ? revision
        : panic("A shard line has no projection revision");
    });

const advanceTo = (model: Model, at: Date, from: Date) => {
  model.offsetMs += Math.max(0, at.getTime() - from.getTime());
};

/**
 * The fake indexer. Before it reads a byte it checks what the run promised:
 * every line belongs to a revision started offline, and no entity in the file
 * was isolated into single requests.
 */
const deliverer =
  (
    model: Model,
    deliveries: Delivery[],
    onDelivery?: () => Promise<void>,
  ): CorpusProjectionOfflineDelivery =>
  async (
    shard: CorpusProjectionOfflineShard,
  ): Promise<CorpusProjectionOfflineDeliveryOutcome> => {
    model.shards.push(shard);
    await onDelivery?.();
    const behaviour = deliveries.shift() ?? "ingest";
    const lines = await linesOf(shard);
    const revisions = [...new Set(lines)];
    const intents = await db
      .select({
        id: corpusIndexProjectionIntents.id,
        family: corpusIndexProjectionIntents.family,
        generation: corpusIndexProjectionIntents.generation,
        entityId: corpusIndexProjectionIntents.entityId,
        epoch: corpusIndexProjectionIntents.epoch,
        fingerprint: corpusIndexProjectionIntents.fingerprint,
        indexId: corpusIndexProjectionIntents.indexId,
        leaseToken: corpusIndexProjectionIntents.leaseToken,
        leaseExpiresAt: corpusIndexProjectionIntents.leaseExpiresAt,
        status: corpusIndexProjectionIntents.status,
        appendDelivery: corpusIndexProjectionIntents.appendDelivery,
        expectedDocumentCount:
          corpusIndexProjectionIntents.expectedDocumentCount,
        appendMode: corpusIndexProjectionStates.appendMode,
        appendRequestId: corpusIndexProjectionIntents.appendRequestId,
      })
      .from(corpusIndexProjectionIntents)
      .innerJoin(
        corpusIndexProjectionStates,
        and(
          eq(
            corpusIndexProjectionStates.family,
            corpusIndexProjectionIntents.family,
          ),
          eq(
            corpusIndexProjectionStates.generation,
            corpusIndexProjectionIntents.generation,
          ),
          eq(
            corpusIndexProjectionStates.entityId,
            corpusIndexProjectionIntents.entityId,
          ),
        ),
      )
      .where(
        inArray(
          corpusIndexProjectionIntents.id,
          revisions.map((revision) =>
            toSafeId<"corpusIndexProjectionIntent">(revision),
          ),
        ),
      );
    expect(intents.length).toBe(revisions.length);
    for (const intent of intents) {
      expect(intent.status).toBe("append_started");
      expect(intent.appendDelivery).toBe("offline_indexer");
      // An entity that delivers alone is never in a file with another.
      if (intents.length > 1) {
        expect(intent.appendMode).toBe("batchable");
      }
      expect(intent.expectedDocumentCount).toBe(
        lines.filter((line) => line === intent.id).length,
      );
    }
    expect(shard.revisionCount).toBe(revisions.length);
    expect(shard.documentCount).toBe(lines.length);
    // One file is one request, within every revision's request cap, and of
    // one cap class: a revision capped to one is alone, and a revision an
    // empty delivery capped never shares a file with one capped otherwise.
    const caps = await db.transaction(
      async (tx) =>
        await readCorpusProjectionOfflineRequestCapsTx(
          asTestRaw<Transaction>(tx),
          intents.map(
            (intent) =>
              ({
                intentId: intent.id,
                family: intent.family,
                generation: intent.generation,
                entityId: intent.entityId,
                epoch: intent.epoch,
                fingerprint: intent.fingerprint,
                indexId: intent.indexId,
                leaseToken:
                  intent.leaseToken ?? panic("Started without a lease"),
                leaseExpiresAt:
                  intent.leaseExpiresAt ?? panic("Started without a lease"),
                appendMode: intent.appendMode,
              }) satisfies CorpusProjectionIntentLease,
          ),
        ),
    );
    const capValues = [...caps.values()];
    expect(shard.revisionCount).toBeLessThanOrEqual(Math.min(...capValues));
    expect(shard.revisionCount).toBeLessThanOrEqual(model.maxShardRevisions);
    expect(
      new Set(capValues.map((cap) => Math.min(cap, model.maxShardRevisions)))
        .size,
    ).toBe(1);
    if (capValues.includes(1)) {
      expect(shard.revisionCount).toBe(1);
    }
    // A file is exactly one request: every revision carries its identity,
    // and every revision that carries it is in the file.
    const requestIds = new Set(
      intents.map(({ appendRequestId }) => appendRequestId),
    );
    expect(requestIds.size).toBe(1);
    const requestId =
      intents.at(0)?.appendRequestId ?? panic("A file has no request");
    const [requestRows] = await db
      .select({ count: sql<number>`count(*)::integer` })
      .from(corpusIndexProjectionIntents)
      .where(eq(corpusIndexProjectionIntents.appendRequestId, requestId));
    expect(requestRows?.count).toBe(revisions.length);
    const poisoned = intents.some(({ entityId }) =>
      model.poisoned.has(entityId),
    );
    model.deliveries.push({ revisions: revisions.length, poisoned });

    const startedAt = await now(model);
    const publish = (skip: string | null) => {
      if (model.finishedPaths.has(shard.path)) {
        return;
      }
      let skipped = false;
      for (const revision of lines) {
        if (!skipped && revision === skip) {
          skipped = true;
          continue;
        }
        model.published.set(revision, (model.published.get(revision) ?? 0) + 1);
      }
      model.finishedPaths.add(shard.path);
    };
    const killed =
      async (): Promise<CorpusProjectionOfflineDeliveryOutcome> => {
        advanceTo(model, shard.killDeadline, startedAt);
        return {
          type: "killed_at_deadline",
          exitCode: 137,
          startedAt,
          endedAt: await now(model),
        };
      };
    model.offsetMs += 1000;
    if (poisoned) {
      // The run publishes nothing: the indexer failed on what it read.
      model.finishedPaths.add(shard.path);
      return {
        type: "failed",
        exitCode: 1,
        cause: "indexer",
        startedAt,
        endedAt: await now(model),
      };
    }
    if (behaviour === "ingest") {
      publish(null);
      return {
        type: "ingested",
        exitCode: 0,
        startedAt,
        endedAt: await now(model),
      };
    }
    if (typeof behaviour === "object") {
      publish(revisions.at(0) ?? null);
      return behaviour.reject.exitCode === 0
        ? {
            type: "ingested",
            exitCode: 0,
            startedAt,
            endedAt: await now(model),
          }
        : {
            type: "failed",
            exitCode: 1,
            cause: "indexer",
            startedAt,
            endedAt: await now(model),
          };
    }
    switch (behaviour) {
      case "kill_before_publish":
        return await killed();
      case "kill_after_publish":
        publish(null);
        return await killed();
      case "refuse":
        advanceTo(model, shard.killDeadline, startedAt);
        return { type: "deadline_passed", refusedAt: await now(model) };
      case "empty":
      case "broken":
        model.finishedPaths.add(shard.path);
        return {
          type: "failed",
          exitCode: 1,
          cause: behaviour === "empty" ? "indexer" : "infrastructure",
          startedAt,
          endedAt: await now(model),
        };
      case "throw":
        throw new Error("the delivery lost its connection to the indexer host");
      case "crash_before":
        model.dead = true;
        throw new SimulatedCrash({
          message: "process died before the indexer ran",
        });
      case "crash_after_publish":
        publish(null);
        model.dead = true;
        throw new SimulatedCrash({
          message: "process died after the indexer published",
        });
      default:
        behaviour satisfies never;
        return panic(`Unhandled delivery: ${String(behaviour)}`);
    }
  };

/** Move one entity's desired state to a new epoch, as a canonical change does. */
const changeDesired = async (entityId: string) => {
  await db.transaction(async (tx) => {
    const [document] = await tx
      .update(legislationDocuments)
      .set({
        projectionEpoch: sql`${legislationDocuments.projectionEpoch} + 1`,
      })
      .where(
        eq(legislationDocuments.id, toSafeId<"legislationDocument">(entityId)),
      )
      .returning({ epoch: legislationDocuments.projectionEpoch });
    await tx
      .update(corpusIndexProjectionStates)
      .set({
        desiredEpoch: document?.epoch ?? panic("No canonical row"),
        workStatus: "eligible",
        retryNotBefore: null,
        failureAttempts: 0,
        lastFailureKind: null,
        lastFailureMessage: null,
      })
      .where(eq(corpusIndexProjectionStates.entityId, entityId));
  });
};

/** An entity whose newest revision is in `status`, if any. */
const entityIn = async (model: Model, status: CorpusIndexIntentStatus) =>
  (await readIntents(model.entityIds)).find(
    (intent) => intent.status === status,
  )?.entityId;

type RunCommand = {
  type: "run";
  crash: CrashPoint;
  deliveries: Delivery[];
  slots: 1 | 2;
  /** Move a reserved entity's desired state just before its start. */
  changeBeforeStart: boolean;
  /** Move a started entity's desired state just before its record. */
  changeBeforeRecord: boolean;
  /** The run's shard size, when not the model's default. */
  maxShardRevisions?: number;
  /** The process dies right before the run's start transaction of this index. */
  dieBeforeStartTransaction?: number;
  /** The run's start transaction of this index waits this long first. */
  holdStartTransaction?: { index: number; ms: number };
  /** The generation starts serving right before this reservation page. */
  serveBeforeReservePage?: number;
  /** Every start admission waits this long, as a busy governor does. */
  holdStartAdmissionMs?: number;
  /** Collects the revisions of every start admission. */
  startUnits?: number[];
  /** Called as each shard reaches the indexer. */
  onDelivery?: () => Promise<void>;
};

type Command = RunCommand | { type: "advance"; ms: number };

/**
 * A lease the virtual clock has passed expires now, so the sweep, which
 * compares leases with the database clock, sees it.
 */
const expirePassedLeases = async (model: Model) => {
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
};

/** The session lock of one process; a dead process's session releases it. */
const lockOf = (model: Model): CorpusProjectionOfflineBuildLock => ({
  tryAcquire: async () => {
    if (model.lockHeld) {
      return null;
    }
    model.lockHeld = true;
    const hold: CorpusProjectionOfflineBuildLockHold = {
      stillHeld: async () => model.lockHeld,
      release: async () => {
        model.lockHeld = false;
        model.lockReleasedAt = await now(model);
      },
    };
    return hold;
  },
});

/**
 * An admission that admits everything at once. It moves one entity's desired
 * state at the first start or record a command asks for, and marks a start
 * admission so the transaction runner can let the process die before, or
 * hold back, the start transaction a command names.
 */
const admissionOf = (
  model: Model,
  command: RunCommand,
): CorpusProjectionOfflineAdmission => {
  let changedBeforeStart = !command.changeBeforeStart;
  let changedBeforeRecord = !command.changeBeforeRecord;
  let reservePages = 0;
  return async <Value>(
    unit: CorpusProjectionOfflineWorkUnit,
    work: () => Promise<Value>,
  ): Promise<Value> => {
    if (unit.phase === "reserve") {
      if (command.serveBeforeReservePage === reservePages) {
        await db
          .update(corpusIndexGenerations)
          .set({ status: "serving" })
          .where(eq(corpusIndexGenerations.generation, TARGET.generation));
      }
      reservePages += 1;
    }
    if (unit.phase === "start" && !changedBeforeStart) {
      const entity = await entityIn(model, "reserved");
      if (entity !== undefined) {
        changedBeforeStart = true;
        await changeDesired(entity);
      }
    }
    if (unit.phase === "record" && !changedBeforeRecord) {
      const entity = await entityIn(model, "append_started");
      if (entity !== undefined) {
        changedBeforeRecord = true;
        await changeDesired(entity);
      }
    }
    if (unit.phase !== "start") {
      return await work();
    }
    command.startUnits?.push(unit.revisions);
    model.offsetMs += command.holdStartAdmissionMs ?? 0;
    model.inStartAdmission = true;
    try {
      return await work();
    } finally {
      model.inStartAdmission = false;
    }
  };
};

const runBuild = async (
  model: Model,
  command: RunCommand,
  resumeAfter: CorpusProjectionOfflineBuildProgress["cursor"] = null,
): Promise<CorpusProjectionOfflineBuildOutcome | null> => {
  model.transactions = 0;
  model.crash = command.crash;
  model.maxShardRevisions = command.maxShardRevisions ?? SHARD_REVISIONS;
  model.dead = false;
  model.inStartAdmission = false;
  model.startTransactions = 0;
  model.dieBeforeStartTransaction = command.dieBeforeStartTransaction ?? null;
  model.holdStartTransaction = command.holdStartTransaction ?? null;
  model.lockReleasedAt = null;
  await expirePassedLeases(model);
  const deadline = new Date((await now(model)).getTime() + RUN_MS);
  const outcome = await Result.tryPromise({
    try: async () =>
      await buildCorpusProjectionRouteOffline({
        runInTransaction: transactionRunner(model),
        client: {
          aggregate: async ({ query }) =>
            Result.ok({
              projection_revisions: {
                buckets: Array.from(model.published, ([key, count]) => ({
                  key,
                  doc_count: count,
                })).filter(
                  ({ key, doc_count }) =>
                    doc_count > 0 && query.includes(`"${key}"`),
                ),
                doc_count_error_upper_bound: 0,
                sum_other_doc_count: 0,
              },
            }),
        },
        ...TARGET,
        indexId: await routeOf(model),
        runId: "model",
        shardDirectory,
        deadline,
        policy: {
          ...POLICY,
          slots: command.slots,
          maxShardRevisions: model.maxShardRevisions,
        },
        deliver: deliverer(model, [...command.deliveries], command.onDelivery),
        lock: lockOf(model),
        admit: admissionOf(model, command),
        resumeAfter,
        testing: {
          clock: async () => await now(model),
          sleep: async (milliseconds) => {
            // A dead process waits for nothing.
            if (!model.dead) {
              model.offsetMs += milliseconds;
            }
          },
          payloadReader: async (_runInTransaction, material) =>
            Result.ok({
              text: `Text of ${material.lease.entityId}.`,
              ast: null,
            }),
        },
      }),
    catch: (cause) => cause,
  });
  model.crash = { type: "none" };
  if (outcome.isErr()) {
    if (!SimulatedCrash.is(outcome.error)) {
      throw outcome.error;
    }
    // The process is gone, and its session with it: the lock is free again.
    model.lockHeld = false;
    return null;
  }
  return outcome.value;
};

const routeOf = async (model: Model) =>
  (
    await db
      .select({ indexId: corpusIndexProjectionStates.desiredIndexId })
      .from(corpusIndexProjectionStates)
      .where(
        eq(
          corpusIndexProjectionStates.entityId,
          model.entityIds.at(0) ?? panic("No entity"),
        ),
      )
  ).at(0)?.indexId ?? panic("Seeded entity has no index");

const applyCommand = async (model: Model, command: Command) => {
  switch (command.type) {
    case "run":
      await runBuild(model, command);
      return;
    case "advance":
      model.offsetMs += command.ms;
      return;
    default:
      command satisfies never;
      panic(`Unhandled model command: ${String(command)}`);
  }
};

/**
 * What must hold after every step, crash or not:
 * - every revision the engine holds has a row (a file holds only started
 *   revisions);
 * - an applied revision holds exactly its documents;
 * - a withdrawn revision holds none;
 * - a committed revision holds no lease;
 * - no entity has more than one revision in flight beside the one it serves.
 */
const assertStepInvariants = async (model: Model) => {
  const intents = await readIntents(model.entityIds);
  const states = await readStates(model.entityIds);
  const ids = new Set<string>(intents.map(({ id }) => String(id)));
  for (const revision of model.published.keys()) {
    expect(ids.has(revision)).toBe(true);
  }
  for (const intent of intents) {
    model.reached.add(intent.status);
    const published = model.published.get(intent.id) ?? 0;
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
      expect({ applied: intent.id, published }).toEqual({
        applied: intent.id,
        published:
          intent.expectedDocumentCount ?? panic("Applied without a count"),
      });
    }
  }
  for (const state of states) {
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

const newModel = async (entities = ENTITIES): Promise<Model> => {
  // Each model starts from an empty route: the build walks the whole route.
  await db.execute(
    sql`TRUNCATE ${corpusIndexProjectionIntents}, ${corpusIndexProjectionStates}`,
  );
  await db
    .delete(legislationDocuments)
    .where(eq(legislationDocuments.sourceId, SOURCE_ID));
  return {
    entityIds: await seedEntities(entities),
    offsetMs: 0,
    published: new Map(),
    finishedPaths: new Set(),
    shards: [],
    crash: { type: "none" },
    transactions: 0,
    lockHeld: false,
    reached: new Set(),
    poisoned: new Set(),
    maxShardRevisions: SHARD_REVISIONS,
    deliveries: [],
    repeatableRead: false,
    switchToSingleAfterReserve: false,
    switchedToSingle: null,
    dead: false,
    inStartAdmission: false,
    startTransactions: 0,
    dieBeforeStartTransaction: null,
    holdStartTransaction: null,
    lockReleasedAt: null,
  };
};

const runCommands = async (model: Model, commands: readonly Command[]) => {
  for (const command of commands) {
    await applyCommand(model, command);
    await assertStepInvariants(model);
  }
};

const QUIET_RUN = {
  type: "run",
  crash: { type: "none" },
  deliveries: [],
  slots: 1,
  changeBeforeStart: false,
  changeBeforeRecord: false,
} as const satisfies RunCommand;

/**
 * Later runs with nothing failing, until every entity is applied, blocked,
 * or was handed to the per-row path with nothing left in flight.
 */
const drain = async (model: Model) => {
  for (let round = 0; round < 6; round += 1) {
    model.offsetMs += Math.max(PLAN.leaseMs, PLAN.endedAfterMs) + 60_000;
    await runBuild(model, QUIET_RUN);
    await assertStepInvariants(model);
    const intents = await readIntents(model.entityIds);
    const states = await readStates(model.entityIds);
    const settled = states.every(
      (state) =>
        state.appliedRevision !== null ||
        state.workStatus === "blocked" ||
        (state.appendMode === "single" &&
          intents.every(
            ({ entityId, status }) =>
              entityId !== state.entityId ||
              ["withdrawn", "cancelled", "settled", "cleanup_pending"].includes(
                status,
              ),
          )),
    );
    if (settled) {
      return;
    }
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
    adapterKey: "projection-offline-build-test",
    name: "Projection offline build test",
  });
  shardDirectory = await mkdtemp(path.join(tmpdir(), "offline-build-"));
});

afterAll(async () => {
  await client.close();
  await rm(shardDirectory, { recursive: true, force: true });
});

const crashPoint: fc.Arbitrary<CrashPoint> = fc.oneof(
  { weight: 1, arbitrary: fc.constant({ type: "none" } as const) },
  {
    weight: 3,
    arbitrary: fc.record({
      type: fc.constant("transaction" as const),
      index: fc.integer({ min: 0, max: 40 }),
      phase: fc.constantFrom("before" as const, "rollback" as const),
    }),
  },
);

/** Kills, refusals and process deaths: nothing a document did. */
const crashDelivery: fc.Arbitrary<Delivery> = fc.constantFrom(
  "ingest",
  "ingest",
  "kill_before_publish",
  "kill_after_publish",
  "refuse",
  "crash_before",
  "crash_after_publish",
);

const anyDelivery: fc.Arbitrary<Delivery> = fc.oneof(
  { weight: 4, arbitrary: crashDelivery },
  {
    weight: 1,
    arbitrary: fc.record({
      reject: fc.record({ exitCode: fc.constantFrom(0 as const, 1 as const) }),
    }),
  },
);

/** Every indexer behaviour that leaves the batch process alive. */
const survivedDelivery: fc.Arbitrary<Delivery> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.constantFrom(
      "ingest" as const,
      "ingest" as const,
      "kill_before_publish" as const,
      "kill_after_publish" as const,
      "refuse" as const,
    ),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      reject: fc.record({ exitCode: fc.constantFrom(0 as const, 1 as const) }),
    }),
  },
);

const runCommand = (
  delivery: fc.Arbitrary<Delivery>,
  changes: boolean,
): fc.Arbitrary<Command> =>
  fc.record({
    type: fc.constant("run" as const),
    crash: crashPoint,
    deliveries: fc.array(delivery, { maxLength: 4 }),
    slots: fc.constantFrom(1 as const, 2 as const),
    changeBeforeStart: changes ? fc.boolean() : fc.constant(false),
    changeBeforeRecord: changes ? fc.boolean() : fc.constant(false),
  });

const advance: fc.Arbitrary<Command> = fc.record({
  type: fc.constant("advance" as const),
  ms: fc.constantFrom(1000, PLAN.killBudgetMs, PLAN.leaseMs + 1000),
});

const CLEANUP_STATUSES = new Set<CorpusIndexIntentStatus>([
  "cleanup_pending",
  "cleanup_started",
  "cleanup_committed",
  "cleanup_stalled",
  "settled",
]);

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

describe("offline route build", () => {
  test(
    "an offline route build converges under a crash at any step with no cleanup",
    async () => {
      const reached = tally();
      await assertProperty(
        "an offline route build converges under a crash at any step with no cleanup",
        fc.asyncProperty(
          fc.array(
            fc.oneof(
              { weight: 3, arbitrary: runCommand(crashDelivery, false) },
              { weight: 1, arbitrary: advance },
            ),
            { minLength: 1, maxLength: 5 },
          ),
          async (commands) => {
            const model = await newModel();
            await runCommands(model, commands);
            await drain(model);
            reached.add(model);
            const intents = await readIntents(model.entityIds);
            const states = await readStates(model.entityIds);
            // Crashes, kills and refusals alone never cost a delete: every
            // started revision is applied or withdrawn.
            for (const status of model.reached) {
              expect(CLEANUP_STATUSES.has(status)).toBe(false);
            }
            for (const intent of intents) {
              expect(["applied", "withdrawn", "cancelled"]).toContain(
                intent.status,
              );
            }
            // An empty delivery keeps its entities batched, in smaller
            // requests, so later runs serve every entity.
            for (const state of states) {
              expect(state.appendMode).toBe("batchable");
              const served = intents.find(
                ({ id }) => id === state.appliedRevision,
              );
              expect(served?.status).toBe("applied");
            }
          },
        ),
        { numRuns: 40 },
      );
      expect(reached.of("withdrawn")).toBeGreaterThan(0);
      expect(reached.of("applied")).toBeGreaterThan(0);
      expect(reached.of("append_committed")).toBeGreaterThan(0);
    },
    propertyTestTimeout(600_000),
  );

  test(
    "every revision an offline route build started ends decided, and none it gave up holds a document",
    async () => {
      const reached = tally();
      await assertProperty(
        "every revision an offline route build started ends decided, and none it gave up holds a document",
        fc.asyncProperty(
          fc.array(
            fc.oneof(
              { weight: 3, arbitrary: runCommand(anyDelivery, true) },
              { weight: 1, arbitrary: advance },
            ),
            { minLength: 1, maxLength: 5 },
          ),
          async (commands) => {
            const model = await newModel();
            await runCommands(model, commands);
            await drain(model);
            reached.add(model);
            for (const intent of await readIntents(model.entityIds)) {
              const published = model.published.get(intent.id) ?? 0;
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
        { numRuns: 40 },
      );
      expect(reached.of("withdrawn")).toBeGreaterThan(0);
      expect(reached.of("cleanup_pending")).toBeGreaterThan(0);
    },
    propertyTestTimeout(600_000),
  );

  test(
    "one offline route build accounts for every revision it reserved",
    async () => {
      await assertProperty(
        "one offline route build accounts for every revision it reserved",
        fc.asyncProperty(
          fc.array(survivedDelivery, { maxLength: 4 }),
          fc.constantFrom(1 as const, 2 as const),
          async (deliveries, slots) => {
            const model = await newModel();
            const outcome = await runBuild(model, {
              ...QUIET_RUN,
              deliveries,
              slots,
            });
            await assertStepInvariants(model);
            const { progress, status: ended } =
              outcome ?? panic("A run without crashes did not finish");
            // A refusal is an infrastructure failure, and a kill of a shard
            // this small leaves no smaller cap: both stop the run, typed.
            expect([
              "drained",
              "infrastructure_failed",
              "rate_too_slow",
            ]).toContain(ended);
            if (deliveries.every((delivery) => delivery === "ingest")) {
              expect(ended).toBe("drained");
            }
            const states = await readStates(model.entityIds);
            const intents = await readIntents(model.entityIds);
            const { notStarted } = progress;
            expect(progress.reserved).toBe(
              progress.started +
                notStarted.cancelled +
                notStarted.leaseLost +
                notStarted.retryScheduled +
                notStarted.blocked +
                notStarted.handedBack,
            );
            expect(progress.recorded).toBe(progress.started);
            expect(progress.recorded).toBe(
              progress.proved +
                progress.withdrawn +
                progress.sentToCleanup +
                progress.blockedByProof +
                progress.superseded +
                progress.awaitingProof,
            );
            expect(progress.awaitingProof).toBe(0);
            expect(progress.shards.delivered).toBe(model.shards.length);
            expect(progress.proved).toBe(
              intents.filter(({ status }) => status === "applied").length,
            );
            // Every entity the run handed back is in single requests now.
            expect(progress.perRowHandoffs).toBe(
              states.filter(({ appendMode }) => appendMode === "single").length,
            );
            if (deliveries.every((delivery) => delivery === "ingest")) {
              expect(progress.proved).toBe(ENTITIES);
              expect(progress.perRowHandoffs).toBe(0);
            }
            // Every shard name is fresh, and every file is gone.
            expect(new Set(model.shards.map(({ name }) => name)).size).toBe(
              model.shards.length,
            );
          },
        ),
        { numRuns: 32 },
      );
    },
    propertyTestTimeout(600_000),
  );

  test("a refused shard of many entities leaves them batched, and the next run delivers them in halves", async () => {
    const model = await newModel();
    const first = await runBuild(model, {
      ...QUIET_RUN,
      deliveries: ["refuse"],
      maxShardRevisions: 8,
    });
    expect(model.deliveries).toEqual([
      { revisions: ENTITIES, poisoned: false },
    ]);
    expect(first?.progress.withdrawn).toBe(ENTITIES);
    expect(first?.progress.perRowHandoffs).toBe(0);
    // Nobody is charged for an empty run of many: every entity stays
    // batched, uncharged, and retries shortly.
    for (const state of await readStates(model.entityIds)) {
      expect(state).toMatchObject({
        appendMode: "batchable",
        workStatus: "retry_scheduled",
        failureAttempts: 0,
      });
    }
    model.offsetMs += 60_000;
    const second = await runBuild(model, {
      ...QUIET_RUN,
      maxShardRevisions: 8,
    });
    expect(model.deliveries.slice(1)).toEqual([
      { revisions: ENTITIES / 2, poisoned: false },
      { revisions: ENTITIES / 2, poisoned: false },
    ]);
    expect(second?.progress.proved).toBe(ENTITIES);
  });

  test("a revision that keeps its run from publishing is blocked within floor(log2 N) + 5 deliveries while its shard mates apply", async () => {
    const model = await newModel();
    const poison = model.entityIds.at(2) ?? panic("No entity");
    model.poisoned.add(poison);
    for (let round = 0; round < 16; round += 1) {
      // Past the retry each charged attempt schedules.
      model.offsetMs += 10 * 60_000;
      await runBuild(model, { ...QUIET_RUN, maxShardRevisions: 8 });
      await assertStepInvariants(model);
      const states = await readStates(model.entityIds);
      if (
        states.find(({ entityId }) => entityId === poison)?.workStatus ===
        "blocked"
      ) {
        break;
      }
    }
    const states = await readStates(model.entityIds);
    for (const state of states) {
      if (state.entityId === poison) {
        expect(state.workStatus).toBe("blocked");
      } else {
        expect(state.appliedRevision).not.toBeNull();
      }
    }
    const withPoison = model.deliveries.filter(({ poisoned }) => poisoned);
    // Halved from a request of N until alone, then charged to the limit.
    expect(withPoison.length).toBeLessThanOrEqual(
      Math.floor(Math.log2(ENTITIES)) + 5,
    );
    expect(withPoison.map(({ revisions }) => revisions)).toEqual([
      ENTITIES,
      ENTITIES / 2,
      1,
      1,
      1,
      1,
      1,
    ]);
  });

  test("revisions capped to one are each delivered alone, and uncapped ones never join them", async () => {
    const model = await newModel();
    // Shards of three that published nothing: each of their revisions may
    // next start only in a request of one.
    await runBuild(model, {
      ...QUIET_RUN,
      deliveries: ["empty", "empty"],
      maxShardRevisions: 3,
    });
    expect(model.deliveries.map(({ revisions }) => revisions)).toEqual([
      3, 3, 1, 1, 1, 1, 1, 1,
    ]);
    const later = await seedEntities(4);
    model.entityIds.push(...later);
    model.offsetMs += 60_000;
    const run = await runBuild(model, { ...QUIET_RUN, maxShardRevisions: 8 });
    // The four that never failed share one file, never joined by a capped one.
    expect(model.deliveries.slice(8).map(({ revisions }) => revisions)).toEqual(
      [4],
    );
    expect(run?.progress.proved).toBe(4);
    for (const state of await readStates(model.entityIds)) {
      expect(state).toMatchObject({ failureAttempts: 0 });
      expect(state.appliedRevision).not.toBeNull();
    }
  });

  test("a process death between the start transactions of one request converges, and nothing it started is delivered", async () => {
    const entities = 600;
    const model = await newModel(entities);
    // The request plans all 600 revisions: 512 start, then the process dies
    // before the second transaction.
    expect(
      await runBuild(model, {
        ...QUIET_RUN,
        maxShardRevisions: 8192,
        dieBeforeStartTransaction: 1,
      }),
    ).toBeNull();
    expect(model.deliveries).toEqual([]);
    const crashed = (await readIntents(model.entityIds)).filter(
      ({ status }) => status === "append_started",
    );
    expect(crashed.length).toBe(512);
    for (let round = 0; round < 4; round += 1) {
      model.offsetMs += PLAN.leaseMs + PLAN.endedAfterMs + 60_000;
      await runBuild(model, { ...QUIET_RUN, maxShardRevisions: 8192 });
      await assertStepInvariants(model);
    }
    const intents = await readIntents(model.entityIds);
    // Nothing of the crashed request reached the engine: its revisions are
    // withdrawn, and each entity was delivered later in a request of at most
    // half of what that request delivered (checked by the fake indexer).
    for (const { id } of crashed) {
      expect(intents.find((intent) => intent.id === id)?.status).toBe(
        "withdrawn",
      );
    }
    for (const state of await readStates(model.entityIds)) {
      expect(state.appliedRevision).not.toBeNull();
      expect(state.appendMode).toBe("batchable");
    }
    expect(
      Math.max(...model.deliveries.map(({ revisions }) => revisions)),
    ).toBeLessThanOrEqual(256);
  });

  test("a request handed back mid-run by a closed start window is delivered by the same run, which walks again from the head", async () => {
    const entities = 600;
    const model = await newModel(entities);
    // The request plans all 600: 512 start, then its second start
    // transaction runs past the start window and starts nothing.
    const run = await runBuild(model, {
      ...QUIET_RUN,
      maxShardRevisions: 8192,
      holdStartTransaction: {
        index: 1,
        ms: CORPUS_PROJECTION_OFFLINE_START_WINDOW_MS + 1000,
      },
    });
    const { progress, status } = run ?? panic("The run did not finish");
    expect(status).toBe("drained");
    // The 88 handed back sit behind the first pass's cursor; the second
    // pass, from the head, reserves and delivers exactly them.
    expect(model.deliveries.map(({ revisions }) => revisions)).toEqual([
      512,
      entities - 512,
    ]);
    expect(progress.notStarted.handedBack).toBe(entities - 512);
    expect(progress.walk.passes).toBeGreaterThanOrEqual(2);
    expect(progress.reserved).toBe(
      progress.started +
        progress.notStarted.cancelled +
        progress.notStarted.leaseLost +
        progress.notStarted.retryScheduled +
        progress.notStarted.blocked +
        progress.notStarted.handedBack,
    );
    expect(progress.started).toBe(entities);
    expect(progress.proved).toBe(entities);
    for (const state of await readStates(model.entityIds)) {
      expect(state.appliedRevision).not.toBeNull();
    }
  });

  test("a start admission covers the whole request, so a governor that waits never splits it across the start window", async () => {
    const entities = 600;
    const model = await newModel(entities);
    const starts: number[] = [];
    const run = await runBuild(model, {
      ...QUIET_RUN,
      maxShardRevisions: 8192,
      // As long as a lease allows between a shard's close and its start.
      holdStartAdmissionMs: POLICY.closeAllowanceMs - 1000,
      startUnits: starts,
    });
    // One admission per request, of the whole request, and the request then
    // started in full, in one file.
    expect(starts).toEqual([entities]);
    expect(model.deliveries.map(({ revisions }) => revisions)).toEqual([
      entities,
    ]);
    expect(run?.progress.notStarted.handedBack).toBe(0);
    expect(run?.progress.proved).toBe(entities);
  });

  // timeout: up to 24 whole offline build runs over 600 entities, each building, delivering and proving against PGlite.
  test("a revision that keeps a request of more than one transaction from publishing is blocked within floor(log2 N) + 5 deliveries", async () => {
    const entities = 600;
    const model = await newModel(entities);
    const poison = model.entityIds.at(2) ?? panic("No entity");
    model.poisoned.add(poison);
    for (let round = 0; round < 24; round += 1) {
      model.offsetMs += 10 * 60_000;
      await runBuild(model, { ...QUIET_RUN, maxShardRevisions: 8192 });
      const states = await readStates([poison]);
      if (states.at(0)?.workStatus === "blocked") {
        break;
      }
    }
    await assertStepInvariants(model);
    for (const state of await readStates(model.entityIds)) {
      if (state.entityId === poison) {
        expect(state.workStatus).toBe("blocked");
      } else {
        expect(state.appliedRevision).not.toBeNull();
      }
    }
    const withPoison = model.deliveries.filter(({ poisoned }) => poisoned);
    expect(withPoison.at(0)?.revisions).toBe(entities);
    expect(withPoison.length).toBeLessThanOrEqual(
      Math.floor(Math.log2(entities)) + 5,
    );
    // Each delivery with it held at most half the one before, until alone.
    for (const [index, delivery] of withPoison.entries()) {
      const before = withPoison.at(index - 1);
      if (index > 0 && before !== undefined && before.revisions > 1) {
        expect(delivery.revisions).toBeLessThanOrEqual(
          Math.floor(before.revisions / 2),
        );
      }
    }
  }, 600_000);

  test("an entity isolated into single requests is left to the per-row path", async () => {
    const model = await newModel();
    const isolated = model.entityIds.at(1) ?? panic("No entity");
    // What a retirement from a shared request leaves behind.
    await db.execute(
      sql`UPDATE ${corpusIndexProjectionStates}
        SET append_mode = 'single'
        WHERE entity_id = ${isolated}`,
    );
    const run = await runBuild(model, { ...QUIET_RUN, maxShardRevisions: 8 });
    expect(run?.progress.reserved).toBe(ENTITIES - 1);
    expect(run?.progress.proved).toBe(ENTITIES - 1);
    const intents = await readIntents([isolated]);
    expect(intents).toEqual([]);
  });

  test("an entity switched to single delivery after its reservation is started and delivered alone", async () => {
    const model = await newModel();
    model.switchToSingleAfterReserve = true;
    const run = await runBuild(model, { ...QUIET_RUN, maxShardRevisions: 8 });
    const single = model.switchedToSingle ?? panic("No entity was switched");
    expect(run?.progress.proved).toBe(ENTITIES);
    // The rest together, built from the same page; the single one after, in
    // a file of its own.
    expect(model.deliveries.map(({ revisions }) => revisions)).toEqual([
      ENTITIES - 1,
      1,
    ]);
    const [intent] = await db
      .select({ requestId: corpusIndexProjectionIntents.appendRequestId })
      .from(corpusIndexProjectionIntents)
      .where(eq(corpusIndexProjectionIntents.entityId, single));
    const [request] = await db
      .select({ count: sql<number>`count(*)::integer` })
      .from(corpusIndexProjectionIntents)
      .where(
        eq(
          corpusIndexProjectionIntents.appendRequestId,
          intent?.requestId ?? panic("Started without a request"),
        ),
      );
    expect(request?.count).toBe(1);
  });

  test("an offline start runs only first in a fresh read committed transaction", async () => {
    /** The guard's refusal after `prepare`, or null when it lets the start run. */
    const guard = async (prepare: (tx: Transaction) => Promise<void>) =>
      (
        await Result.tryPromise({
          try: async () =>
            await db.transaction(async (raw) => {
              const tx = asTestRaw<Transaction>(raw);
              await prepare(tx);
              await requireFreshReadCommittedStartTx(tx);
            }),
          catch: (cause: unknown) =>
            cause instanceof Error ? cause.message : String(cause),
        })
      ).match({ ok: () => null, err: (message) => message });
    const model = await newModel(1);
    const entityId = model.entityIds.at(0) ?? panic("No entity");
    expect(await guard(async () => undefined)).toBeNull();
    // A read takes no lock that could close a cycle.
    expect(
      await guard(async (tx) => {
        await tx.execute(
          sql`SELECT entity_id FROM ${corpusIndexProjectionStates} WHERE entity_id = ${entityId}`,
        );
      }),
    ).toBeNull();
    expect(
      await guard(async (tx) => {
        await tx.execute(
          sql`SELECT entity_id FROM ${corpusIndexProjectionStates} WHERE entity_id = ${entityId} FOR UPDATE`,
        );
      }),
    ).toContain("holds no lock yet");
    expect(
      await guard(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(1, 2)`);
      }),
    ).toContain("holds no lock yet");
    expect(
      await guard(async (tx) => {
        await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      }),
    ).toContain("read committed");

    // A caller whose transactions run in repeatable read starts nothing.
    const refused = await newModel();
    refused.repeatableRead = true;
    expect(
      await rejectionOf(
        runBuild(refused, { ...QUIET_RUN, maxShardRevisions: 8 }),
      ),
    ).toMatchObject({
      message: expect.stringContaining("must run in read committed"),
    });
    expect(refused.deliveries).toEqual([]);
    expect(
      (await readIntents(refused.entityIds)).filter(
        ({ status }) => status !== "reserved",
      ),
    ).toEqual([]);
  });

  test("a second run on the same route is refused while the first holds its lock", async () => {
    const model = await newModel();
    model.lockHeld = true;
    const outcome = await runBuild(model, QUIET_RUN);
    expect(outcome?.status).toBe("lock_held");
    expect(await readIntents(model.entityIds)).toEqual([]);
  });

  test("a pass that reaches the end of the queue does not end the walk: work behind a resumed cursor is delivered by the same run", async () => {
    const model = await newModel();
    const first = await runBuild(model, QUIET_RUN);
    expect(first?.status).toBe("drained");
    expect(first?.progress.proved).toBe(ENTITIES);
    // One entity sorts after the cursor the run resumes from, one before it.
    const seeded = await seedEntities(2);
    const ahead = seeded.at(0) ?? panic("Expected two entities");
    const behind = seeded.at(1) ?? panic("Expected two entities");
    model.entityIds.push(ahead, behind);
    await db.execute(
      sql`UPDATE ${corpusIndexProjectionStates}
        SET updated_at = clock_timestamp() - interval '2 hours'
        WHERE entity_id = ${behind}`,
    );
    const [cursorRow] = (
      await db.execute<{ runnableAt: string }>(
        sql`SELECT (clock_timestamp() - interval '1 hour')::text AS "runnableAt"`,
      )
    ).rows;
    const cursor = {
      runnableAt: cursorRow?.runnableAt ?? panic("No cursor instant"),
      entityId: "00000000-0000-0000-0000-000000000000",
    };
    const resumed = await runBuild(model, QUIET_RUN, cursor);
    // The first pass, from the cursor, reads only `ahead` and its short page
    // ends that pass, not the walk: the next pass, from the head, takes
    // `behind`.
    expect(resumed?.status).toBe("drained");
    expect(resumed?.progress.reserved).toBe(2);
    expect(resumed?.progress.proved).toBe(2);
    expect(resumed?.progress.walk.passes).toBeGreaterThanOrEqual(2);
    for (const state of await readStates([ahead, behind])) {
      expect(state.appliedRevision).not.toBeNull();
    }
  });

  test("a delivery that fails outside its documents stops the run and charges nobody, however often the runner relaunches", async () => {
    const model = await newModel();
    // Every revision travels alone, where a document fault would be charged.
    for (let launch = 0; launch < 8; launch += 1) {
      model.offsetMs += 10 * 60_000;
      // db-await-in-loop: one whole run per relaunch, each after the last
      const outcome = await runBuild(model, {
        ...QUIET_RUN,
        deliveries: [launch % 2 === 0 ? "broken" : "refuse"],
        maxShardRevisions: 1,
      });
      expect(outcome?.status).toBe("infrastructure_failed");
      expect(outcome?.progress.shards.infrastructureFailures).toBe(1);
      expect(outcome?.progress.shards.delivered).toBe(1);
      await assertStepInvariants(model);
    }
    for (const state of await readStates(model.entityIds)) {
      expect(state.workStatus).not.toBe("blocked");
      expect(state.failureAttempts).toBe(0);
      expect(state.appendMode).toBe("batchable");
    }
    // Once the engine is back, the next run delivers every entity.
    model.offsetMs += 10 * 60_000;
    const healed = await runBuild(model, {
      ...QUIET_RUN,
      maxShardRevisions: 8,
    });
    expect(healed?.status).toBe("drained");
    for (const state of await readStates(model.entityIds)) {
      expect(state.appliedRevision).not.toBeNull();
    }
  });

  test("a shard killed too large is never charged, and a cap that cannot shrink further stops the run typed", async () => {
    const model = await newModel();
    const outcome = await runBuild(model, {
      ...QUIET_RUN,
      deliveries: ["kill_before_publish"],
      maxShardRevisions: 1,
    });
    // A shard this small killed means a rate below the slowest the plan
    // accepts: half of it cannot hold the largest revision.
    expect(outcome?.status).toBe("rate_too_slow");
    expect(outcome?.progress.shards.killedTooLarge).toBe(1);
    expect(outcome?.progress.withdrawn).toBe(1);
    for (const state of await readStates(model.entityIds)) {
      expect(state.failureAttempts).toBe(0);
      expect(state.workStatus).not.toBe("blocked");
    }
  });

  test("a shard killed at its deadline whose census is exact is a merge that ran over, not a failure", async () => {
    const model = await newModel();
    const outcome = await runBuild(model, {
      ...QUIET_RUN,
      deliveries: ["kill_after_publish"],
      maxShardRevisions: 2,
    });
    expect(outcome?.status).toBe("drained");
    expect(outcome?.progress.shards.mergeOverruns).toBe(1);
    expect(outcome?.progress.shards.killedTooLarge).toBe(0);
    expect(outcome?.progress.shards.shardByteCap).toBe(PLAN.shardByteCap);
    expect(outcome?.progress.proved).toBe(ENTITIES);
  });

  test("a new holder delivers only after the indexers an earlier holder started have certainly ended", async () => {
    const model = await newModel();
    // The earlier process dies while its indexer may still run.
    expect(
      await runBuild(model, {
        ...QUIET_RUN,
        deliveries: ["crash_before"],
        maxShardRevisions: 2,
      }),
    ).toBeNull();
    const [latest] = await db
      .select({
        startedAt: sql<string>`max(${corpusIndexProjectionIntents.appendStartedAt})::text`,
      })
      .from(corpusIndexProjectionIntents)
      .where(inArray(corpusIndexProjectionIntents.entityId, model.entityIds));
    const endedAtMs =
      new Date(latest?.startedAt ?? panic("Nothing started")).getTime() +
      PLAN.endedAfterMs;
    const delivered = model.shards.length;
    const deliveredAt: number[] = [];
    const outcome = await runBuild(model, {
      ...QUIET_RUN,
      maxShardRevisions: 2,
      onDelivery: async () => {
        deliveredAt.push((await now(model)).getTime());
      },
    });
    expect(outcome?.status).toBe("drained");
    expect(model.shards.length).toBeGreaterThan(delivered);
    expect(Math.min(...deliveredAt)).toBeGreaterThanOrEqual(endedAtMs);
  });

  test("a run whose delivery rejects keeps the route until that delivery's indexer has certainly ended", async () => {
    const model = await newModel();
    const failure = await rejectionOf(
      runBuild(model, {
        ...QUIET_RUN,
        deliveries: ["throw"],
        maxShardRevisions: 2,
      }),
    );
    expect(failure).toMatchObject({
      message: expect.stringContaining("lost its connection"),
    });
    const shard = model.shards.at(0) ?? panic("Nothing was delivered");
    expect(model.lockHeld).toBe(false);
    expect(
      (model.lockReleasedAt ?? panic("The lock was never released")).getTime(),
    ).toBeGreaterThanOrEqual(
      shard.killDeadline.getTime() +
        CORPUS_PROJECTION_OFFLINE_INDEXER_END_MARGIN_MS,
    );
  });

  test("a reservation page re-checks that the generation is still building", async () => {
    const model = await newModel();
    const outcome = await runBuild(model, {
      ...QUIET_RUN,
      serveBeforeReservePage: 0,
    });
    await db
      .update(corpusIndexGenerations)
      .set({ status: "building" })
      .where(eq(corpusIndexGenerations.generation, TARGET.generation));
    expect(outcome?.status).toBe("generation_not_building");
    expect(outcome?.progress.reserved).toBe(0);
    expect(await readIntents(model.entityIds)).toEqual([]);
  });
});
