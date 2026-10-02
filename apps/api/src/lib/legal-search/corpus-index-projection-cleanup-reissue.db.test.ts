import { panic, Result } from "better-result";
import { afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { Temporal } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type {
  CorpusIndexClient,
  CorpusIndexDeleteSettlement,
} from "@/api/lib/legal-search/corpus-index-client";
import { corpusIndexMaturationPeriodMs } from "@/api/lib/legal-search/corpus-index-config";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  claimCorpusProjectionCleanupSettlementTx,
  claimCorpusProjectionCleanupTx,
  CORPUS_PROJECTION_DELETE_REISSUE_LIMIT,
  type CorpusProjectionCleanupReissue,
  type CorpusProjectionCleanupSettlementLease,
  CorpusProjectionCleanupSettlementProof,
  recordCorpusProjectionDeleteTx,
  reissueCorpusProjectionCleanupTx,
  releaseCorpusProjectionCleanupSettlementTx,
  settleCorpusProjectionCleanupTx,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const DELETE_TASK_CREATED_AT = Temporal.Instant.from("2026-08-25T12:00:00Z");
/** Past every manifest's maturation period, so a survivor can stand. */
const LONG_AFTER_THE_TASK = DELETE_TASK_CREATED_AT.add({ hours: 24 * 8 });
const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000301",
);
const FIRST_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000302",
);
const SECOND_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000303",
);
const FIRST_INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000304",
);
const SECOND_INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000305",
);
const INTENT_IDS = [FIRST_INTENT_ID, SECOND_INTENT_ID] as const;
const REVISIONS = [
  {
    intentId: FIRST_INTENT_ID,
    entityId: FIRST_DECISION_ID,
    caseNumber: "1 A 1/2026",
    fingerprint: "a".repeat(64),
  },
  {
    intentId: SECOND_INTENT_ID,
    entityId: SECOND_DECISION_ID,
    caseNumber: "1 A 2/2026",
    fingerprint: "b".repeat(64),
  },
] as const;
const CLEANUP_LEASE_TOKEN = "0198e331-e578-7000-8000-000000000306";
const SETTLEMENT_LEASE_TOKEN = "0198e331-e578-7000-8000-000000000307";
const SUCCESSOR_LEASE_TOKEN = "0198e331-e578-7000-8000-000000000308";
const INDEX_ID = "case_law_v5_cs_sk";
const SEEDED_AT = new Date("2026-08-25T00:00:00.000Z");
const DRIZZLE_DIR = new URL("../../../drizzle/", import.meta.url);
const SCOPE = {
  family: "case_law",
  generation: "case_law_v5",
  indexId: INDEX_ID,
} as const;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let seededSnapshot: Blob;

const installProjectionMigrationDdl = async (): Promise<void> => {
  const projectionMigrations = [
    ...new Bun.Glob("*corpus*projection*/migration.sql").scanSync(
      Bun.fileURLToPath(DRIZZLE_DIR),
    ),
  ]
    .filter((migration) => !migration.includes("projection_revision"))
    .toSorted();
  for (const migration of projectionMigrations) {
    const text = await Bun.file(new URL(migration, DRIZZLE_DIR)).text();
    for (const statement of text.split("--> statement-breakpoint")) {
      const ddl = statement.trim();
      if (
        /(?:^|\n)\s*CREATE (?:OR REPLACE )?FUNCTION\b/u.test(ddl) ||
        /(?:^|\n)\s*CREATE TRIGGER\b/u.test(ddl)
      ) {
        await db.execute(sql.raw(ddl));
      }
    }
  }
};

const buildSeededSnapshot = async (): Promise<Blob> => {
  db = drizzle({ client });
  await installProjectionMigrationDdl();
  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "projection-reissue-test",
    name: "Projection reissue test",
  });
  await db.insert(caseLawDecisions).values(
    REVISIONS.map(({ entityId, caseNumber }) => ({
      id: entityId,
      sourceId: SOURCE_ID,
      caseNumber,
      court: "Test court",
      country: "CZE",
      language: "cs",
      contentHash: "c".repeat(64),
      projectionEpoch: 1n,
    })),
  );
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: "case_law_v5",
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
    ),
    status: "building",
  });
  await db.insert(corpusIndexProjectionStates).values(
    REVISIONS.map(({ entityId, fingerprint }) => ({
      family: "case_law" as const,
      generation: "case_law_v5",
      entityId,
      desiredAction: "upsert" as const,
      desiredEpoch: 1n,
      desiredFingerprint: fingerprint,
      desiredIndexId: INDEX_ID,
      updatedAt: SEEDED_AT,
    })),
  );
  await db.execute(
    sql`ALTER TABLE corpus_index_projection_intents DISABLE TRIGGER corpus_index_projection_intents_insert_guard`,
  );
  await db.insert(corpusIndexProjectionIntents).values(
    REVISIONS.map(({ intentId, entityId, fingerprint }) => ({
      id: intentId,
      family: "case_law" as const,
      generation: "case_law_v5",
      entityId,
      epoch: 1n,
      fingerprint,
      indexId: INDEX_ID,
      status: "cleanup_pending" as const,
      appendStartedAt: SEEDED_AT,
      appendPublishBarrierAt: SEEDED_AT,
      cleanupNotBefore: SEEDED_AT,
    })),
  );
  await db.execute(
    sql`ALTER TABLE corpus_index_projection_intents ENABLE TRIGGER corpus_index_projection_intents_insert_guard`,
  );
  return await client.dumpDataDir("none");
};

beforeAll(async () => {
  client = await createTestPglite();
  try {
    seededSnapshot = await buildSeededSnapshot();
  } finally {
    await client.close();
  }
});

beforeEach(async () => {
  client = await createTestPglite(seededSnapshot);
  db = drizzle({ client });
});

afterEach(async () => {
  await client.close();
});

const inTx = async <T>(operation: (tx: Transaction) => Promise<T>) =>
  await db.transaction(
    async (tx) => await operation(asTestRaw<Transaction>(tx)),
  );

/** One cleanup turn: claim both pending revisions and record one delete. */
const commitDelete = async (deleteOpstamp: number): Promise<void> => {
  const leases = await inTx(
    async (tx) =>
      await claimCorpusProjectionCleanupTx(tx, {
        ...SCOPE,
        limit: 10,
        leaseMs: 60_000,
        newLeaseToken: () => CLEANUP_LEASE_TOKEN,
      }),
  );
  expect(leases.map(({ intentId }) => intentId).toSorted()).toEqual([
    ...INTENT_IDS,
  ]);
  await inTx(
    async (tx) =>
      await recordCorpusProjectionDeleteTx(tx, {
        intentIds: INTENT_IDS,
        indexId: INDEX_ID,
        leaseToken: CLEANUP_LEASE_TOKEN,
        deleteOpstamp,
        deleteTaskCreatedAt: DELETE_TASK_CREATED_AT,
      }),
  );
};

const claimSettlement = async (
  leaseToken: string,
  testNow?: Date,
): Promise<CorpusProjectionCleanupSettlementLease[]> =>
  await inTx(
    async (tx) =>
      await claimCorpusProjectionCleanupSettlementTx(tx, {
        ...SCOPE,
        limit: 10,
        taskLimit: 1,
        leaseMs: 60_000,
        ...(testNow === undefined ? {} : { testNow }),
        newLeaseToken: () => leaseToken,
      }),
  );

const claimOneSettlement = async (leaseToken: string, testNow?: Date) =>
  (await claimSettlement(leaseToken, testNow)).at(0) ??
  panic("Expected a projection settlement lease");

/**
 * An engine whose every split crossed the opstamp, with `remaining` revision
 * documents still found by the exact count.
 */
const engineWithRemaining = (remaining: number) =>
  ({
    readDeleteSettlements: async ({ tasks }) =>
      Result.ok(
        tasks.map(({ requiredOpstamp }) =>
          Result.ok({
            requiredOpstamp,
            provingSplits: 2,
            excludedSplits: 1,
            laggingSplits: 0,
            minAppliedOpstamp: requiredOpstamp,
            settled: true,
            laggingProvingSplits: [],
            laggingExcludedSplits: [],
          } satisfies CorpusIndexDeleteSettlement),
        ),
      ),
    search: async () =>
      Result.ok({ numHits: remaining, hits: [], snippets: [] }),
  }) satisfies Pick<CorpusIndexClient, "readDeleteSettlements" | "search">;

const verifyOne = async (
  lease: CorpusProjectionCleanupSettlementLease,
  remaining: number,
  testNow = LONG_AFTER_THE_TASK,
) => {
  const verdict = (
    await CorpusProjectionCleanupSettlementProof.verifyAll({
      client: engineWithRemaining(remaining),
      indexId: INDEX_ID,
      leases: [lease],
      testNow,
    })
  ).at(0);
  if (verdict === undefined || verdict.result.isErr()) {
    return panic("Expected one settlement verdict");
  }
  return verdict.result.value;
};

const survivorOf = async (
  lease: CorpusProjectionCleanupSettlementLease,
): Promise<CorpusProjectionCleanupReissue> => {
  const result = await verifyOne(lease, 3);
  if (result.status !== "pending" || result.reason !== "survivor") {
    return panic("Expected a survivor verdict");
  }
  expect(result.remainingRevisionCount).toBe(3);
  return result.reissue;
};

const reissue = async (evidence: CorpusProjectionCleanupReissue) =>
  await inTx(
    async (tx) =>
      await reissueCorpusProjectionCleanupTx(tx, { reissue: evidence }),
  );

const readIntents = async () =>
  await db
    .select({
      id: corpusIndexProjectionIntents.id,
      status: corpusIndexProjectionIntents.status,
      leaseToken: corpusIndexProjectionIntents.leaseToken,
      deleteOpstamp: corpusIndexProjectionIntents.deleteOpstamp,
      deleteTaskCreatedAt: corpusIndexProjectionIntents.deleteTaskCreatedAt,
      cleanupStartedAt: corpusIndexProjectionIntents.cleanupStartedAt,
      deleteReissues: corpusIndexProjectionIntents.deleteReissues,
      cleanupAttempts: corpusIndexProjectionIntents.cleanupAttempts,
      lastError: corpusIndexProjectionIntents.lastError,
    })
    .from(corpusIndexProjectionIntents)
    .where(inArray(corpusIndexProjectionIntents.id, [...INTENT_IDS]))
    .orderBy(asc(corpusIndexProjectionIntents.id));

test("a survivor goes back to cleanup, and the new delete settles", async () => {
  await commitDelete(42);
  const lease = await claimOneSettlement(SETTLEMENT_LEASE_TOKEN);

  expect(await reissue(await survivorOf(lease))).toEqual({
    reissuedIntentIds: [...INTENT_IDS],
    stalledIntentIds: [],
    unleasedIntentIds: [],
  });
  const reissued = await readIntents();
  for (const intent of reissued) {
    expect(intent).toMatchObject({
      status: "cleanup_pending",
      leaseToken: null,
      deleteOpstamp: null,
      deleteTaskCreatedAt: null,
      cleanupStartedAt: null,
      deleteReissues: 1,
      cleanupAttempts: 1,
    });
    expect(intent.lastError).toContain("delete re-issued");
  }

  // The ordinary cleanup path issues the new delete, and it proves.
  await commitDelete(57);
  const next = await claimOneSettlement(SETTLEMENT_LEASE_TOKEN);
  expect(next.deleteOpstamp).toBe(57);
  const verified = await verifyOne(next, 0);
  if (verified.status !== "verified") {
    return panic("Expected the re-issued delete to settle");
  }
  expect(
    await inTx(
      async (tx) =>
        await settleCorpusProjectionCleanupTx(tx, { proof: verified.proof }),
    ),
  ).toBe(INTENT_IDS.length);
  expect(
    (await readIntents()).map(
      ({ status, deleteReissues, cleanupAttempts }) => ({
        status,
        deleteReissues,
        cleanupAttempts,
      }),
    ),
  ).toEqual(
    INTENT_IDS.map(() => ({
      status: "settled",
      deleteReissues: 1,
      cleanupAttempts: 2,
    })),
  );
});

test("a survivor-shaped verdict inside the maturation period re-issues nothing", async () => {
  await commitDelete(42);
  const lease = await claimOneSettlement(SETTLEMENT_LEASE_TOKEN);

  const result = await verifyOne(
    lease,
    3,
    DELETE_TASK_CREATED_AT.add({ minutes: 5 }),
  );

  if (result.status !== "pending" || result.reason !== "survivor_unconfirmed") {
    return panic("Expected an unconfirmed survivor");
  }
  // Confirmable once the index's maturation period has passed since the task.
  expect(result.confirmableAt).toEqual(
    DELETE_TASK_CREATED_AT.add({
      milliseconds: corpusIndexMaturationPeriodMs(
        CORPUS_INDEX_MANIFESTS.case_law_v5.engine.indexConfig.indexing_settings
          .merge_policy.maturation_period,
      ),
    }),
  );
  expect("reissue" in result).toBe(false);
  expect(
    await inTx(
      async (tx) =>
        await releaseCorpusProjectionCleanupSettlementTx(tx, { lease }),
    ),
  ).toBe(INTENT_IDS.length);
  expect((await readIntents()).map(({ status }) => status)).toEqual(
    INTENT_IDS.map(() => "cleanup_committed"),
  );
});

test("replaying a reissue changes nothing", async () => {
  await commitDelete(42);
  const evidence = await survivorOf(
    await claimOneSettlement(SETTLEMENT_LEASE_TOKEN),
  );
  await reissue(evidence);
  const afterFirst = await readIntents();

  expect(await reissue(evidence)).toEqual({
    reissuedIntentIds: [],
    stalledIntentIds: [],
    unleasedIntentIds: [...INTENT_IDS],
  });
  expect(await readIntents()).toEqual(afterFirst);
});

test("a reissue whose lease a successor took over after expiry leaves the successor's revisions", async () => {
  await commitDelete(42);
  // Leased against a clock in the past, so the database clock sees it expired
  // and the successor's claim takes the revisions over.
  const outrun = await claimOneSettlement(
    SETTLEMENT_LEASE_TOKEN,
    new Date("2026-08-25T12:00:00.000Z"),
  );
  const successor = await claimOneSettlement(SUCCESSOR_LEASE_TOKEN);
  expect(successor.intentIds).toEqual(outrun.intentIds);
  const outrunEvidence = await survivorOf(outrun);

  expect(await reissue(outrunEvidence)).toEqual({
    reissuedIntentIds: [],
    stalledIntentIds: [],
    unleasedIntentIds: [...INTENT_IDS],
  });
  expect(
    (await readIntents()).map(({ status, leaseToken, deleteReissues }) => ({
      status,
      leaseToken,
      deleteReissues,
    })),
  ).toEqual(
    INTENT_IDS.map(() => ({
      status: "cleanup_committed",
      leaseToken: SUCCESSOR_LEASE_TOKEN,
      deleteReissues: 0,
    })),
  );
  // The successor's own verdict still re-issues.
  expect(
    (await reissue(await survivorOf(successor))).reissuedIntentIds,
  ).toEqual([...INTENT_IDS]);
});

test("re-issued revisions leave the settlement queue for the cleanup queue", async () => {
  await commitDelete(42);
  const lease = await claimOneSettlement(SETTLEMENT_LEASE_TOKEN);
  const evidence = await survivorOf(lease);
  await reissue(evidence);

  // Reissued revisions are cleanup work again, not settlement work.
  expect(await claimSettlement(SUCCESSOR_LEASE_TOKEN)).toEqual([]);
});

test("revisions at the reissue limit stall instead of re-issuing", async () => {
  await commitDelete(42);
  await db
    .update(corpusIndexProjectionIntents)
    .set({ deleteReissues: CORPUS_PROJECTION_DELETE_REISSUE_LIMIT })
    .where(eq(corpusIndexProjectionIntents.id, FIRST_INTENT_ID));
  const evidence = await survivorOf(
    await claimOneSettlement(SETTLEMENT_LEASE_TOKEN),
  );

  expect(await reissue(evidence)).toEqual({
    reissuedIntentIds: [SECOND_INTENT_ID],
    stalledIntentIds: [FIRST_INTENT_ID],
    unleasedIntentIds: [],
  });
  const [stalled, reissued] = await readIntents();
  expect(stalled).toMatchObject({
    id: FIRST_INTENT_ID,
    status: "cleanup_stalled",
    leaseToken: null,
    // The last receipt stays as evidence of the delete that left survivors.
    deleteOpstamp: 42n,
    deleteReissues: CORPUS_PROJECTION_DELETE_REISSUE_LIMIT,
  });
  expect(stalled?.lastError).toContain("cleanup stalled");
  expect(reissued).toMatchObject({
    id: SECOND_INTENT_ID,
    status: "cleanup_pending",
    deleteReissues: 1,
  });

  // A stall is out of every worker path: no settlement lease, and the cleanup
  // claim takes only the re-issued revision.
  expect(await claimSettlement(SUCCESSOR_LEASE_TOKEN)).toEqual([]);
  const cleanup = await inTx(
    async (tx) =>
      await claimCorpusProjectionCleanupTx(tx, {
        ...SCOPE,
        limit: 10,
        leaseMs: 60_000,
        newLeaseToken: () => CLEANUP_LEASE_TOKEN,
      }),
  );
  expect(cleanup.map(({ intentId }) => intentId)).toEqual([SECOND_INTENT_ID]);
});

test("the reissue count bounds repeated survivors", async () => {
  await commitDelete(42);
  const outcomes: string[] = [];
  for (
    let round = 0;
    round <= CORPUS_PROJECTION_DELETE_REISSUE_LIMIT;
    round += 1
  ) {
    const result = await reissue(
      await survivorOf(await claimOneSettlement(SETTLEMENT_LEASE_TOKEN)),
    );
    outcomes.push(result.stalledIntentIds.length > 0 ? "stalled" : "reissued");
    if (result.reissuedIntentIds.length > 0) {
      await commitDelete(43 + round);
    }
  }

  expect(outcomes).toEqual([
    ...Array.from(
      { length: CORPUS_PROJECTION_DELETE_REISSUE_LIMIT },
      () => "reissued",
    ),
    "stalled",
  ]);
  expect(
    (await readIntents()).map(({ status, deleteReissues }) => ({
      status,
      deleteReissues,
    })),
  ).toEqual(
    INTENT_IDS.map(() => ({
      status: "cleanup_stalled",
      deleteReissues: CORPUS_PROJECTION_DELETE_REISSUE_LIMIT,
    })),
  );
});

test("the database refuses a stalled revision that holds a lease or settles", async () => {
  await commitDelete(42);
  await reissue(
    await survivorOf(await claimOneSettlement(SETTLEMENT_LEASE_TOKEN)),
  );
  await commitDelete(43);
  await db
    .update(corpusIndexProjectionIntents)
    .set({ deleteReissues: CORPUS_PROJECTION_DELETE_REISSUE_LIMIT })
    .where(inArray(corpusIndexProjectionIntents.id, [...INTENT_IDS]));
  await reissue(
    await survivorOf(await claimOneSettlement(SETTLEMENT_LEASE_TOKEN)),
  );

  const rejection = async (statement: Promise<unknown>) =>
    await statement.then(
      () => "accepted",
      (error: unknown) => {
        const messages: string[] = [];
        let current: unknown = error;
        while (current instanceof Error) {
          messages.push(current.message);
          current = current.cause;
        }
        return messages.join(" | ");
      },
    );
  expect(
    await rejection(
      db.execute(sql`
        UPDATE corpus_index_projection_intents
        SET lease_token = ${SUCCESSOR_LEASE_TOKEN},
            lease_expires_at = now() + interval '1 minute'
        WHERE id = ${FIRST_INTENT_ID}
      `),
    ),
  ).toContain("corpus_index_projection_intents_status_shape");
  expect(
    await rejection(
      db.execute(sql`
        UPDATE corpus_index_projection_intents
        SET status = 'settled', settled_at = now()
        WHERE id = ${FIRST_INTENT_ID}
      `),
    ),
  ).toContain("invalid corpus index projection intent transition");
  expect(
    await rejection(
      db.execute(sql`
        UPDATE corpus_index_projection_intents
        SET delete_reissues = -1
        WHERE id = ${FIRST_INTENT_ID}
      `),
    ),
  ).toContain("corpus_index_projection_intents_delete_reissues_nonnegative");
});
