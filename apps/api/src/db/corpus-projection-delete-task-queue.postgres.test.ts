import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";
import { Temporal } from "@stll/time";

import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionDeleteTasks,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  claimCorpusProjectionCleanupSettlementTx,
  claimCorpusProjectionCleanupTx,
  type CorpusProjectionCleanupSettlementLease,
  CorpusProjectionCleanupSettlementProof,
  recordCorpusProjectionDeleteTx,
  reissueCorpusProjectionCleanupTx,
  releaseCorpusProjectionCleanupSettlementTx,
  settleCorpusProjectionCleanupTx,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import {
  type GatedTestClientScope,
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";

import {
  createCorpusProjectionDeleteTaskRepair,
  queueNextCorpusProjectionDeleteTasks,
} from "./corpus-projection-delete-task-repair";
import { createUngatedTableGateForTests } from "./online-ddl";
import type { OnlineMigrationConnection } from "./online-migration-connection";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/** A manifest generation no other gated suite registers. */
const GENERATION = "case_law_v12";
const FAMILY = "case_law" as const;
const DELETE_TASK_CREATED_AT = Temporal.Instant.from("2026-08-25T12:00:00Z");
const LONG_AFTER_THE_TASK = DELETE_TASK_CREATED_AT.add({ hours: 24 * 8 });
const LEASE_MS = 60_000;
const ENTITIES_PER_RUN = 10;

type IntentId = SafeId<"corpusIndexProjectionIntent">;

const engineWithRemaining = (remaining: number) =>
  ({
    readDeleteSettlements: async ({ tasks }) =>
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
    search: async () =>
      Result.ok({ numHits: remaining, hits: [], snippets: [] }),
  }) satisfies Pick<CorpusIndexClient, "readDeleteSettlements" | "search">;

/** Thrown inside a transaction to model a process dying before it commits. */
class CrashError extends Error {
  override name = "CrashError";
}

const rollsBack = async (work: Promise<unknown>): Promise<void> => {
  const outcome = await Result.tryPromise({
    try: async () => await work,
    catch: (error) => error,
  });
  if (!outcome.isErr() || !(outcome.error instanceof CrashError)) {
    panic("Expected the transaction to crash");
  }
};

type Suite = {
  sourceId: string;
  entityIds: string[];
  intentIds: IntentId[];
  indexIds: string[];
};

const registerGeneration = async (db: GatedTestDb): Promise<string> => {
  await db.insert(corpusIndexGenerations).values({
    family: FAMILY,
    generation: GENERATION,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v12,
    ),
    status: "building",
  });
  const sourceId = Bun.randomUUIDv7();
  await db.insert(caseLawSources).values({
    id: toSafeId<"caseLawSource">(sourceId),
    adapterKey: `delete-task-queue-${sourceId}`,
    name: "Delete task queue",
  });
  return sourceId;
};

/**
 * One index's revisions in `cleanup_pending`, reached through the transitions
 * the guards admit: reserved, append started, then cleanup.
 */
const seedIndex = async (
  db: GatedTestDb,
  suite: Suite,
  count: number,
): Promise<string> => {
  const suffix = Bun.randomUUIDv7().replaceAll("-", "").slice(-12);
  const indexId = `case_law_v12_tasks_${suffix}`;
  const entityIds = Array.from({ length: count }, () => Bun.randomUUIDv7());
  const intentIds = entityIds.map(() =>
    toSafeId<"corpusIndexProjectionIntent">(Bun.randomUUIDv7()),
  );
  const fingerprint = "e".repeat(64);
  const seededAt = new Date("2026-08-25T00:00:00.000Z");
  await db.transaction(async (tx) => {
    await tx.insert(caseLawDecisions).values(
      entityIds.map((id, index) => ({
        id: toSafeId<"caseLawDecision">(id),
        sourceId: toSafeId<"caseLawSource">(suite.sourceId),
        caseNumber: `delete-task-queue-${suffix}-${index}`,
        court: "Test court",
        country: "CZE",
        language: "cs",
        contentHash: "c".repeat(64),
        projectionEpoch: 1n,
      })),
    );
    await tx.insert(corpusIndexProjectionStates).values(
      entityIds.map((entityId) => ({
        family: FAMILY,
        generation: GENERATION,
        entityId,
        desiredAction: "upsert" as const,
        desiredEpoch: 1n,
        desiredFingerprint: fingerprint,
        desiredIndexId: indexId,
        updatedAt: seededAt,
      })),
    );
  });
  await db.insert(corpusIndexProjectionIntents).values(
    entityIds.map((entityId, index) => ({
      id: intentIds[index] ?? panic("intent id"),
      family: FAMILY,
      generation: GENERATION,
      entityId,
      epoch: 1n,
      fingerprint,
      indexId,
      status: "reserved" as const,
      leaseToken: Bun.randomUUIDv7(),
      leaseExpiresAt: seededAt,
    })),
  );
  await db
    .update(corpusIndexProjectionIntents)
    .set({ status: "append_started", appendStartedAt: seededAt })
    .where(inArray(corpusIndexProjectionIntents.id, intentIds));
  await db
    .update(corpusIndexProjectionIntents)
    .set({
      status: "cleanup_pending",
      leaseToken: null,
      leaseExpiresAt: null,
      appendPublishBarrierAt: seededAt,
      cleanupNotBefore: seededAt,
    })
    .where(inArray(corpusIndexProjectionIntents.id, intentIds));
  suite.entityIds.push(...entityIds);
  suite.intentIds.push(...intentIds);
  suite.indexIds.push(indexId);
  return indexId;
};

/** Drives nothing: retires the generation and removes everything it holds. */
const cleanUp = async (db: GatedTestDb, suite: Suite): Promise<void> => {
  const generation = and(
    eq(corpusIndexGenerations.family, FAMILY),
    eq(corpusIndexGenerations.generation, GENERATION),
  );
  // Projection history is deletable only under a retired generation.
  await db
    .update(corpusIndexGenerations)
    .set({ status: "retired" })
    .where(generation);
  await db
    .delete(corpusIndexProjectionIntents)
    .where(
      and(
        eq(corpusIndexProjectionIntents.family, FAMILY),
        eq(corpusIndexProjectionIntents.generation, GENERATION),
      ),
    );
  await db
    .delete(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.family, FAMILY),
        eq(corpusIndexProjectionStates.generation, GENERATION),
      ),
    );
  if (suite.entityIds.length > 0) {
    await db.delete(caseLawDecisions).where(
      inArray(
        caseLawDecisions.id,
        suite.entityIds.map((id) => toSafeId<"caseLawDecision">(id)),
      ),
    );
  }
  await db
    .delete(caseLawSources)
    .where(eq(caseLawSources.id, toSafeId<"caseLawSource">(suite.sourceId)));
  // The delete tasks go with the generation.
  await db.delete(corpusIndexGenerations).where(generation);
};

const connectionOver = ({
  sql: client,
}: ReturnType<GatedTestClientScope["openClient"]>) =>
  ({
    execute: async (query, params = []) => {
      await client.unsafe(query, [...params]);
    },
    query: async (query, params = []): Promise<readonly unknown[]> =>
      await client.unsafe(query, [...params]),
    release: () => {},
  }) satisfies OnlineMigrationConnection;

type Op =
  | { kind: "record"; count: number; legacy: boolean; crash: boolean }
  | { kind: "backfill"; size: number }
  | { kind: "claim"; taskLimit: number; limit: number; crash: boolean }
  | {
      kind: "finish";
      pick: number;
      outcome: "settle" | "settle_crash" | "survivor" | "release" | "abandon";
    };

const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("record" as const),
    count: fc.integer({ min: 1, max: 3 }),
    legacy: fc.boolean(),
    crash: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("backfill" as const),
    size: fc.integer({ min: 1, max: 2 }),
  }),
  fc.record({
    kind: fc.constant("claim" as const),
    taskLimit: fc.integer({ min: 1, max: 3 }),
    limit: fc.integer({ min: 1, max: 3 }),
    crash: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("finish" as const),
    pick: fc.nat(),
    outcome: fc.constantFrom(
      "settle" as const,
      "settle_crash" as const,
      "survivor" as const,
      "release" as const,
      "abandon" as const,
    ),
  }),
);

type TaskKey = readonly [string, string, string, bigint];

const compareKeys = (left: TaskKey, right: TaskKey): number => {
  for (const index of [0, 1, 2] as const) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  if (left[3] === right[3]) {
    return 0;
  }
  return left[3] < right[3] ? -1 : 1;
};

const cursorKey = (cursor: string | null, indexId: string): TaskKey => {
  if (cursor === null) {
    return [FAMILY, GENERATION, indexId, -1n];
  }
  const parsed: unknown = JSON.parse(cursor);
  if (!Array.isArray(parsed) || parsed.length !== 4) {
    return panic("Unexpected walk cursor");
  }
  const [family, generation, index, opstamp] = parsed.map(String);
  return [
    family ?? panic("family"),
    generation ?? panic("generation"),
    index ?? panic("index"),
    BigInt(opstamp ?? panic("opstamp")),
  ];
};

/** A run of interleaved receipts, claims, settlements and crashes. */
class Run {
  readonly live: CorpusProjectionCleanupSettlementLease[] = [];
  /** Opstamps recorded the way an earlier release left them: no task row. */
  readonly legacy = new Set<bigint>();
  readonly settledTimes = new Map<IntentId, number>();
  cursor: string | null;
  nextOpstamp = 1;
  readonly db: GatedTestDb;
  readonly otherDb: GatedTestDb;
  readonly walk: OnlineMigrationConnection;
  readonly indexId: string;

  constructor(
    db: GatedTestDb,
    otherDb: GatedTestDb,
    walk: OnlineMigrationConnection,
    indexId: string,
  ) {
    this.db = db;
    this.otherDb = otherDb;
    this.walk = walk;
    this.indexId = indexId;
    // The walk starts just below this run's index, as it would reach it.
    this.cursor = JSON.stringify([FAMILY, GENERATION, indexId, "-1"]);
  }

  scope() {
    return { family: FAMILY, generation: GENERATION, indexId: this.indexId };
  }

  async apply(op: Op): Promise<void> {
    switch (op.kind) {
      case "record":
        await this.record(op);
        return;
      case "backfill":
        await this.backfill(op.size);
        return;
      case "claim":
        await this.claim(op);
        return;
      case "finish":
        await this.finish(op);
        return;
      default: {
        op satisfies never;
        return panic("Unknown op");
      }
    }
  }

  async record({
    count,
    legacy,
    crash,
  }: Extract<Op, { kind: "record" }>): Promise<void> {
    const leaseToken = Bun.randomUUIDv7();
    const leases = await this.db.transaction(
      async (tx) =>
        (
          await claimCorpusProjectionCleanupTx(tx, {
            ...this.scope(),
            limit: count,
            leaseMs: LEASE_MS,
            newLeaseToken: () => leaseToken,
          })
        ).leases,
    );
    if (leases.length === 0) {
      return;
    }
    const deleteOpstamp = this.nextOpstamp;
    this.nextOpstamp += 1;
    const receipt = {
      intentIds: leases.map(({ intentId }) => intentId),
      indexId: this.indexId,
      leaseToken,
      deleteOpstamp,
      deleteTaskCreatedAt: DELETE_TASK_CREATED_AT,
    };
    if (crash) {
      // The receipt's transaction dies; the retry records it again.
      await rollsBack(
        this.db.transaction(async (tx) => {
          await recordCorpusProjectionDeleteTx(tx, receipt);
          throw new CrashError();
        }),
      );
    }
    await this.db.transaction(async (tx) => {
      await recordCorpusProjectionDeleteTx(tx, receipt);
    });
    // Only a task the walk has not passed yet can be one recorded before the
    // triggers: the walk starts after the migration that added them.
    if (
      legacy &&
      compareKeys(
        [FAMILY, GENERATION, this.indexId, BigInt(deleteOpstamp)],
        cursorKey(this.cursor, this.indexId),
      ) > 0
    ) {
      // Recorded before the queue's triggers existed: the task has no row
      // until the walk reaches it.
      await this.db
        .delete(corpusIndexProjectionDeleteTasks)
        .where(
          and(
            eq(corpusIndexProjectionDeleteTasks.indexId, this.indexId),
            eq(
              corpusIndexProjectionDeleteTasks.deleteOpstamp,
              BigInt(deleteOpstamp),
            ),
          ),
        );
      this.legacy.add(BigInt(deleteOpstamp));
    }
  }

  async backfill(size: number): Promise<void> {
    // The walk runs on its own session, beside the settlement work.
    const step = await queueNextCorpusProjectionDeleteTasks(
      this.walk,
      this.cursor,
      size,
    );
    this.cursor = step.cursor;
  }

  async claim({
    taskLimit,
    limit,
    crash,
  }: Extract<Op, { kind: "claim" }>): Promise<void> {
    const claim = async (db: GatedTestDb) =>
      await db.transaction(async (tx) => {
        const leases = await claimCorpusProjectionCleanupSettlementTx(tx, {
          ...this.scope(),
          limit,
          taskLimit,
          leaseMs: LEASE_MS,
        });
        if (crash) {
          throw new CrashError();
        }
        return leases;
      });
    if (crash) {
      await rollsBack(claim(this.db));
      return;
    }
    // Two turns claim at once on separate sessions; neither waits.
    const [first, second] = await Promise.all([
      claim(this.db),
      claim(this.otherDb),
    ]);
    this.live.push(...first, ...second);
  }

  async finish({
    pick,
    outcome,
  }: Extract<Op, { kind: "finish" }>): Promise<void> {
    if (this.live.length === 0) {
      return;
    }
    const index = pick % this.live.length;
    const lease = this.live[index] ?? panic("lease");
    const verdictOf = async (remaining: number) => {
      const verdict = (
        await CorpusProjectionCleanupSettlementProof.verifyAll({
          client: engineWithRemaining(remaining),
          indexId: lease.indexId,
          leases: [lease],
          testNow: LONG_AFTER_THE_TASK,
        })
      ).at(0);
      if (verdict === undefined || verdict.result.isErr()) {
        return panic("Expected one settlement verdict");
      }
      return verdict.result.value;
    };
    switch (outcome) {
      case "settle": {
        const result = await verdictOf(0);
        if (result.status !== "verified") {
          return panic("Expected a verified settlement");
        }
        const settled = await this.db.transaction(
          async (tx) =>
            await settleCorpusProjectionCleanupTx(tx, { proof: result.proof }),
        );
        expect(settled).toBe(lease.intentIds.length);
        for (const id of lease.intentIds) {
          this.settledTimes.set(id, (this.settledTimes.get(id) ?? 0) + 1);
        }
        this.live.splice(index, 1);
        return;
      }
      case "settle_crash": {
        const result = await verdictOf(0);
        if (result.status !== "verified") {
          return panic("Expected a verified settlement");
        }
        await rollsBack(
          this.db.transaction(async (tx) => {
            await settleCorpusProjectionCleanupTx(tx, { proof: result.proof });
            throw new CrashError();
          }),
        );
        return;
      }
      case "survivor": {
        const result = await verdictOf(2);
        if (result.status !== "pending" || result.reason !== "survivor") {
          return panic("Expected a survivor verdict");
        }
        await this.db.transaction(
          async (tx) =>
            await reissueCorpusProjectionCleanupTx(tx, {
              reissue: result.reissue,
            }),
        );
        this.live.splice(index, 1);
        return;
      }
      case "release": {
        await this.db.transaction(
          async (tx) =>
            await releaseCorpusProjectionCleanupSettlementTx(tx, { lease }),
        );
        this.live.splice(index, 1);
        return;
      }
      case "abandon": {
        // The turn died holding its lease, and the lease ran out since. One
        // claim can lease several tasks under one turn token; all of them
        // ran out with it.
        await this.expire(lease.leaseToken);
        for (let at = this.live.length - 1; at >= 0; at -= 1) {
          if (this.live[at]?.leaseToken === lease.leaseToken) {
            this.live.splice(at, 1);
          }
        }
        return;
      }
      default: {
        outcome satisfies never;
        return panic("Unknown outcome");
      }
    }
  }

  async expire(leaseToken: string): Promise<void> {
    const past = sql<Date>`clock_timestamp() - interval '1 minute'`;
    await this.db
      .update(corpusIndexProjectionIntents)
      .set({ leaseExpiresAt: past })
      .where(eq(corpusIndexProjectionIntents.leaseToken, leaseToken));
    await this.db
      .update(corpusIndexProjectionDeleteTasks)
      .set({ leaseExpiresAt: past })
      .where(eq(corpusIndexProjectionDeleteTasks.leaseToken, leaseToken));
  }

  /** What must hold between any two steps. */
  async checkInvariants(): Promise<void> {
    const committed = await this.db
      .select({
        id: corpusIndexProjectionIntents.id,
        deleteOpstamp: corpusIndexProjectionIntents.deleteOpstamp,
        leaseToken: corpusIndexProjectionIntents.leaseToken,
      })
      .from(corpusIndexProjectionIntents)
      .where(
        and(
          eq(corpusIndexProjectionIntents.indexId, this.indexId),
          eq(corpusIndexProjectionIntents.status, "cleanup_committed"),
        ),
      );
    const tasks = await this.db
      .select({
        deleteOpstamp: corpusIndexProjectionDeleteTasks.deleteOpstamp,
        leaseToken: corpusIndexProjectionDeleteTasks.leaseToken,
      })
      .from(corpusIndexProjectionDeleteTasks)
      .where(eq(corpusIndexProjectionDeleteTasks.indexId, this.indexId));
    const queued = new Set(tasks.map(({ deleteOpstamp }) => deleteOpstamp));
    const walked = cursorKey(this.cursor, this.indexId);
    // No loss: every committed revision's task is queued, unless it was
    // recorded before the triggers and the walk has not reached it yet.
    for (const { deleteOpstamp } of committed) {
      const opstamp = deleteOpstamp ?? panic("Committed without a receipt");
      if (queued.has(opstamp)) {
        continue;
      }
      expect(this.legacy.has(opstamp)).toBe(true);
      expect(
        compareKeys([FAMILY, GENERATION, this.indexId, opstamp], walked),
      ).toBe(1);
    }
    // No double lease: each live lease holds exactly its own revisions and
    // its task, and no two live leases share a revision.
    const leasedBy = new Map<string, string>();
    for (const lease of this.live) {
      for (const id of lease.intentIds) {
        expect(leasedBy.has(id)).toBe(false);
        leasedBy.set(id, lease.leaseToken);
      }
      expect(
        tasks.find(
          ({ deleteOpstamp }) => deleteOpstamp === BigInt(lease.deleteOpstamp),
        )?.leaseToken,
      ).toBe(lease.leaseToken);
    }
    const liveTokens = new Set(this.live.map(({ leaseToken }) => leaseToken));
    for (const { id, leaseToken } of committed) {
      if (leaseToken !== null && liveTokens.has(leaseToken)) {
        expect(leasedBy.get(id)).toBe(leaseToken);
      } else {
        expect(leasedBy.has(id)).toBe(false);
      }
    }
    // No double settlement.
    for (const times of this.settledTimes.values()) {
      expect(times).toBe(1);
    }
  }

  /**
   * The walk finishes, every lease runs out, and settlement drains the queue:
   * every revision that reached `cleanup_committed` leaves it, and the queue
   * holds nothing for the index.
   */
  async drain(): Promise<void> {
    for (;;) {
      // db-await-in-loop: the walk proceeds one batch per transaction.
      const step = await queueNextCorpusProjectionDeleteTasks(
        this.walk,
        this.cursor,
        64,
      );
      this.cursor = step.cursor;
      if (step.done) {
        break;
      }
    }
    for (const lease of this.live.splice(0)) {
      // db-await-in-loop: each lease runs out on its own token.
      await this.expire(lease.leaseToken);
    }
    for (let turn = 0; turn < 64; turn += 1) {
      // db-await-in-loop: settlement turns run one after another, as Plane runs them.
      const leases = await this.db.transaction(
        async (tx) =>
          await claimCorpusProjectionCleanupSettlementTx(tx, {
            ...this.scope(),
            limit: 128,
            taskLimit: 32,
            leaseMs: LEASE_MS,
          }),
      );
      if (leases.length === 0) {
        break;
      }
      this.live.push(...leases);
      while (this.live.length > 0) {
        // db-await-in-loop: one settlement per lease, as the turn proves them.
        await this.finish({ kind: "finish", pick: 0, outcome: "settle" });
      }
    }
    await this.checkInvariants();
    const left = await this.db
      .select({ id: corpusIndexProjectionIntents.id })
      .from(corpusIndexProjectionIntents)
      .where(
        and(
          eq(corpusIndexProjectionIntents.indexId, this.indexId),
          eq(corpusIndexProjectionIntents.status, "cleanup_committed"),
        ),
      );
    expect(left).toEqual([]);
    const queue = await this.db
      .select({ deleteOpstamp: corpusIndexProjectionDeleteTasks.deleteOpstamp })
      .from(corpusIndexProjectionDeleteTasks)
      .where(eq(corpusIndexProjectionDeleteTasks.indexId, this.indexId));
    expect(queue).toEqual([]);
    const settled = await this.db
      .select({ id: corpusIndexProjectionIntents.id })
      .from(corpusIndexProjectionIntents)
      .where(
        and(
          eq(corpusIndexProjectionIntents.indexId, this.indexId),
          eq(corpusIndexProjectionIntents.status, "settled"),
        ),
      );
    expect(settled.map(({ id }) => id).toSorted()).toEqual(
      [...this.settledTimes.keys()].toSorted(),
    );
  }
}

if (!databaseUrl || !runPostgresTests) {
  describe.skip("corpus projection delete task queue (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("corpus projection delete task queue (postgres)", () => {
    // timeout: each property run seeds an index and drives dozens of transactions on real Postgres.
    test("interleaved receipts, claims, settlements, crashes and the backlog walk lose no task and settle none twice", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const { db: otherDb } = openClient();
        const walk = connectionOver(openClient());
        const suite: Suite = {
          sourceId: await registerGeneration(db),
          entityIds: [],
          intentIds: [],
          indexIds: [],
        };
        try {
          await assertProperty(
            "interleaved receipts, claims, settlements, crashes and the backlog walk lose no task and settle none twice",
            fc.asyncProperty(
              fc.array(opArbitrary, { minLength: 1, maxLength: 24 }),
              async (ops) => {
                const indexId = await seedIndex(db, suite, ENTITIES_PER_RUN);
                const run = new Run(db, otherDb, walk, indexId);
                for (const op of ops) {
                  // db-await-in-loop: each step is the interleaving under test.
                  await run.apply(op);
                  await run.checkInvariants();
                }
                await run.drain();
              },
            ),
            { numRuns: 25 },
          );
        } finally {
          await cleanUp(db, suite);
        }
      });
    }, 600_000);

    // timeout: seeds receipts and runs the repair's batches on real Postgres.
    test("the online repair queues every task recorded before the triggers and then reads complete", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db } = openClient();
        const repairClient = openClient();
        const suite: Suite = {
          sourceId: await registerGeneration(db),
          entityIds: [],
          intentIds: [],
          indexIds: [],
        };
        const repair = createCorpusProjectionDeleteTaskRepair({
          sleep: async () => {},
          batchTasks: 2,
          readVerdict: async () => ({
            kind: "normal",
            signals: [
              {
                indicator: "ebs_balance",
                kind: "normal",
                value: 90,
                threshold: 70,
                observedAt: "2026-11-18T08:00:00.000Z",
                reason: "Injected health for repair semantics",
              },
            ],
          }),
        });
        try {
          const indexId = await seedIndex(db, suite, 24);
          const run = new Run(db, db, connectionOver(repairClient), indexId);
          // Twelve tasks give opstamps of one and two digits in one index,
          // which a page cut in text order would skip or overfill.
          for (let task = 0; task < 12; task += 1) {
            // db-await-in-loop: one receipt per delete task.
            await run.record({
              kind: "record",
              count: 2,
              legacy: true,
              crash: false,
            });
          }
          // The fixture reaches the repair's case: committed tasks, no rows.
          expect(run.legacy.size).toBe(12);
          expect(
            await db
              .select()
              .from(corpusIndexProjectionDeleteTasks)
              .where(eq(corpusIndexProjectionDeleteTasks.indexId, indexId)),
          ).toEqual([]);
          const connection = connectionOver(repairClient);
          expect(await repair.readCompletion(connection)).toEqual(
            expect.objectContaining({ type: "incomplete" }),
          );
          expect(
            await repair.repair(
              connection,
              createUngatedTableGateForTests(connection),
            ),
          ).toEqual({
            type: "complete",
          });
          expect(await repair.readCompletion(connection)).toEqual({
            type: "complete",
          });
          const queued = await db
            .select({
              deleteOpstamp: corpusIndexProjectionDeleteTasks.deleteOpstamp,
              taskCreatedAt: corpusIndexProjectionDeleteTasks.taskCreatedAt,
            })
            .from(corpusIndexProjectionDeleteTasks)
            .where(eq(corpusIndexProjectionDeleteTasks.indexId, indexId));
          expect(
            queued
              .map(({ deleteOpstamp }) => deleteOpstamp)
              .toSorted((left, right) => (left < right ? -1 : 1)),
          ).toEqual(Array.from({ length: 12 }, (_, at) => BigInt(at + 1)));
          expect(
            queued.every(
              ({ taskCreatedAt }) =>
                taskCreatedAt.getTime() ===
                DELETE_TASK_CREATED_AT.epochMilliseconds,
            ),
          ).toBe(true);
          // A second run from the start adds nothing.
          await connection.execute(
            "DELETE FROM public.database_backfill_states WHERE name = $1",
            ["corpus-projection-delete-tasks"],
          );
          await repair.repair(
            connection,
            createUngatedTableGateForTests(connection),
          );
          expect(
            await db
              .select({ count: sql<number>`count(*)::int` })
              .from(corpusIndexProjectionDeleteTasks)
              .where(eq(corpusIndexProjectionDeleteTasks.indexId, indexId)),
          ).toEqual([{ count: 12 }]);
          await run.drain();
        } finally {
          await repairClient.sql.unsafe(
            "DELETE FROM public.database_backfill_states WHERE name = $1",
            ["corpus-projection-delete-tasks"],
          );
          await cleanUp(db, suite);
        }
      });
    }, 600_000);
  });
}
