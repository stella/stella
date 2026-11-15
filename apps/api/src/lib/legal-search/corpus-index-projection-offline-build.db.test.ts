import { panic, Result, TaggedError } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import fc from "fast-check";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
} from "@/api/lib/legal-search/corpus-index-projection-offline-build";
import {
  CORPUS_PROJECTION_OFFLINE_DEFAULT_INGEST_BYTES_PER_SECOND,
  CORPUS_PROJECTION_OFFLINE_DEFAULT_MAX_SHARD_BYTES,
  type CorpusProjectionOfflineBuildPolicy,
  planCorpusProjectionOfflineBuild,
} from "@/api/lib/legal-search/corpus-index-projection-offline-plan";
import { EFFECTIVE_CONSOLIDATION } from "@/api/lib/legal-search/legislation-expression-classification";
import { installCorpusProjectionGuards } from "@/api/tests/helpers/corpus-projection-guards";
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
  maxConsecutiveDeliveryFailures: 10,
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
 * - `crash_before` / `crash_after_publish`: the batch process dies while
 *   the shard is delivered, before the indexer ran or after it published.
 */
type Delivery =
  | "ingest"
  | { reject: { exitCode: 0 | 1 } }
  | "kill_before_publish"
  | "kill_after_publish"
  | "refuse"
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
  reached: Set<CorpusIndexIntentStatus>;
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
  (model: Model, deliveries: Delivery[]): CorpusProjectionOfflineDelivery =>
  async (
    shard: CorpusProjectionOfflineShard,
  ): Promise<CorpusProjectionOfflineDeliveryOutcome> => {
    model.shards.push(shard);
    const behaviour = deliveries.shift() ?? "ingest";
    const lines = await linesOf(shard);
    const revisions = [...new Set(lines)];
    const intents = await db
      .select({
        id: corpusIndexProjectionIntents.id,
        status: corpusIndexProjectionIntents.status,
        appendDelivery: corpusIndexProjectionIntents.appendDelivery,
        expectedDocumentCount:
          corpusIndexProjectionIntents.expectedDocumentCount,
        appendMode: corpusIndexProjectionStates.appendMode,
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
      expect(intent.appendMode).toBe("batchable");
      expect(intent.expectedDocumentCount).toBe(
        lines.filter((line) => line === intent.id).length,
      );
    }
    expect(shard.revisionCount).toBe(revisions.length);
    expect(shard.documentCount).toBe(lines.length);
    expect(shard.revisionCount).toBeLessThanOrEqual(SHARD_REVISIONS);

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
        : { type: "failed", exitCode: 1, startedAt, endedAt: await now(model) };
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
      case "crash_before":
        throw new SimulatedCrash({
          message: "process died before the indexer ran",
        });
      case "crash_after_publish":
        publish(null);
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
      },
    };
    return hold;
  },
});

/**
 * An admission that admits everything at once, and moves one entity's
 * desired state at the first start or record a command asks for.
 */
const admissionOf = (
  model: Model,
  command: RunCommand,
): CorpusProjectionOfflineAdmission => {
  let changedBeforeStart = !command.changeBeforeStart;
  let changedBeforeRecord = !command.changeBeforeRecord;
  return async <Value>(
    unit: CorpusProjectionOfflineWorkUnit,
    work: () => Promise<Value>,
  ): Promise<Value> => {
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
    return await work();
  };
};

const runBuild = async (
  model: Model,
  command: RunCommand,
  resumeAfter: CorpusProjectionOfflineBuildProgress["cursor"] = null,
): Promise<CorpusProjectionOfflineBuildOutcome | null> => {
  model.transactions = 0;
  model.crash = command.crash;
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
        policy: { ...POLICY, slots: command.slots },
        deliver: deliverer(model, [...command.deliveries]),
        lock: lockOf(model),
        admit: admissionOf(model, command),
        resumeAfter,
        testing: {
          clock: async () => await now(model),
          sleep: async (milliseconds) => {
            model.offsetMs += milliseconds;
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

const newModel = async (): Promise<Model> => {
  // Each model starts from an empty route: the build walks the whole route.
  await db.execute(
    sql`TRUNCATE ${corpusIndexProjectionIntents}, ${corpusIndexProjectionStates}`,
  );
  await db
    .delete(legislationDocuments)
    .where(eq(legislationDocuments.sourceId, SOURCE_ID));
  return {
    entityIds: await seedEntities(ENTITIES),
    offsetMs: 0,
    published: new Map(),
    finishedPaths: new Set(),
    shards: [],
    crash: { type: "none" },
    transactions: 0,
    lockHeld: false,
    reached: new Set(),
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
 * Later runs with nothing failing, until every entity is applied or was
 * handed to the per-row path with nothing left in flight.
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
  await installCorpusProjectionGuards(db);
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
            // Every entity is served, or was handed to the per-row path
            // after a revision that shared a shard came back empty.
            for (const state of states) {
              const served = intents.find(
                ({ id }) => id === state.appliedRevision,
              );
              if (served === undefined) {
                expect(state.appendMode).toBe("single");
                expect(
                  intents.some(
                    ({ entityId, status }) =>
                      entityId === state.entityId && status === "withdrawn",
                  ),
                ).toBe(true);
              } else {
                expect(served.status).toBe("applied");
              }
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
            expect(ended).toBe("drained");
            const states = await readStates(model.entityIds);
            const intents = await readIntents(model.entityIds);
            const { notStarted } = progress;
            expect(progress.reserved).toBe(
              progress.started +
                notStarted.cancelled +
                notStarted.leaseLost +
                notStarted.retryScheduled +
                notStarted.blocked,
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

  test("a second run on the same route is refused while the first holds its lock", async () => {
    const model = await newModel();
    model.lockHeld = true;
    const outcome = await runBuild(model, QUIET_RUN);
    expect(outcome?.status).toBe("lock_held");
    expect(await readIntents(model.entityIds)).toEqual([]);
  });

  test("a run resumed from a cursor reserves only what the queue holds after it", async () => {
    const model = await newModel();
    const first = await runBuild(model, QUIET_RUN);
    expect(first?.status).toBe("drained");
    expect(first?.progress.proved).toBe(ENTITIES);
    const cursor = first?.progress.cursor ?? panic("The walk left no cursor");
    // Work queued after the first walk sorts after its cursor; one of it is
    // placed behind the cursor, where a resumed walk leaves it to the
    // per-row path and a walk from the head takes it.
    const seeded = await seedEntities(2);
    const ahead = seeded.at(0) ?? panic("Expected two entities");
    const behind = seeded.at(1) ?? panic("Expected two entities");
    model.entityIds.push(ahead, behind);
    await db.execute(
      sql`UPDATE ${corpusIndexProjectionStates}
        SET updated_at = ${cursor.runnableAt}::timestamptz - interval '1 hour'
        WHERE entity_id = ${behind}`,
    );
    const resumed = await runBuild(model, QUIET_RUN, cursor);
    expect(resumed?.progress.reserved).toBe(1);
    expect(resumed?.progress.proved).toBe(1);
    expect(
      (await readStates([ahead, behind])).map(
        ({ entityId, appliedRevision }) => ({
          entityId,
          applied: appliedRevision !== null,
        }),
      ),
    ).toEqual(
      expect.arrayContaining([
        { entityId: ahead, applied: true },
        { entityId: behind, applied: false },
      ]),
    );
    const fromHead = await runBuild(model, QUIET_RUN);
    expect(fromHead?.progress.reserved).toBe(1);
    expect(fromHead?.progress.proved).toBe(1);
  });
});
