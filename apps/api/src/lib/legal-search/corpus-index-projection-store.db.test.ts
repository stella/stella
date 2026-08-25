import { panic, Result } from "better-result";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId, type SafeId } from "@/api/lib/branded-types";
import type { CorpusIndexClient } from "@/api/lib/legal-search/corpus-index-client";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  claimCorpusProjectionCleanupSettlementTx,
  claimCorpusProjectionCleanupTx,
  CorpusProjectionCleanupSettlementProof,
  recordCorpusProjectionDeleteTx,
  recoverExpiredCorpusProjectionIntentsTx,
  releaseCorpusProjectionCleanupSettlementTx,
  reopenCorpusProjectionCleanupTx,
  settleCorpusProjectionCleanupTx,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import { advanceCorpusProjectionDesiredStateTx } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  advanceCorpusProjectionErasuresTx,
  CORPUS_PROJECTION_ERASURE_MAX_REVISIONS,
} from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import {
  abandonCorpusProjectionAppendTx,
  commitCorpusProjectionAppendTx,
  prepareCorpusProjectionReplacementsTx,
  reserveCorpusProjectionIntentsTx,
  startCorpusProjectionAppendTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-000000000201",
);
const DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000202",
);
const FIRST_INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000203",
);
const FIRST_LEASE_TOKEN = "0198e331-e578-7000-8000-000000000204";
const CLEANUP_LEASE_TOKEN = "0198e331-e578-7000-8000-000000000205";
const REOPEN_CLEANUP_LEASE_TOKEN = "0198e331-e578-7000-8000-000000000212";
const SECOND_INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000206",
);
const SECOND_LEASE_TOKEN = "0198e331-e578-7000-8000-000000000207";
const ERASE_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000208",
);
const ERASE_INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000209",
);
const ERASE_LEASE_TOKEN = "0198e331-e578-7000-8000-000000000210";
const ERASE_CLEANUP_TOKEN = "0198e331-e578-7000-8000-000000000211";
const FIRST_FINGERPRINT = "a".repeat(64);
const SECOND_FINGERPRINT = "b".repeat(64);
const INDEX_ID = "case_law_v5_cs_sk";
const PROJECTION_MIGRATION_URLS = [
  new URL(
    "../../../drizzle/20260825142000_corpus_index_projection_intents/migration.sql",
    import.meta.url,
  ),
  new URL(
    "../../../drizzle/20260825211400_corpus_projection_replacement_order/migration.sql",
    import.meta.url,
  ),
  new URL(
    "../../../drizzle/20260826003600_corpus_projection_applied_history_guard/migration.sql",
    import.meta.url,
  ),
] as const;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const setDatabaseClock = async (now: Date): Promise<void> => {
  await db.execute(
    sql.raw(`
      CREATE OR REPLACE FUNCTION public.clock_timestamp()
      RETURNS timestamptz
      LANGUAGE sql
      VOLATILE
      AS $$ SELECT '${now.toISOString()}'::timestamptz $$
    `),
  );
};

const withDatabaseClock = async <T>(
  operation: (tx: Transaction) => Promise<T>,
): Promise<T> =>
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL search_path = public, pg_catalog`);
    return await operation(asTestRaw<Transaction>(tx));
  });

const settledProjectionClient = {
  readDeleteSettlement: async (_indexId, requiredOpstamp) =>
    Result.ok({
      requiredOpstamp,
      publishedSplits: 1,
      laggingSplits: 0,
      minAppliedOpstamp: requiredOpstamp,
      settled: true,
    }),
  search: async () => Result.ok({ numHits: 0, hits: [], snippets: [] }),
} satisfies Pick<CorpusIndexClient, "readDeleteSettlement" | "search">;

const verifySettlement = async ({
  intentIds,
  deleteOpstamp,
}: {
  intentIds: readonly SafeId<"corpusIndexProjectionIntent">[];
  deleteOpstamp: number;
}) => {
  const lease = await db.transaction(
    async (tx) =>
      await claimCorpusProjectionCleanupSettlementTx(
        asTestRaw<Transaction>(tx),
        {
          family: "case_law",
          generation: "case_law_v5",
          indexId: INDEX_ID,
          limit: 10,
          leaseMs: 60_000,
        },
      ),
  );
  if (lease === null) {
    return panic("Expected a projection settlement lease");
  }
  expect(lease.intentIds).toEqual(intentIds);
  expect(lease.deleteOpstamp).toBe(deleteOpstamp);
  const result = await CorpusProjectionCleanupSettlementProof.verify({
    client: settledProjectionClient,
    lease,
  });
  if (result.isErr()) {
    return panic(`Projection settlement verification failed: ${result.error}`);
  }
  if (result.value.status !== "verified") {
    return panic("Projection settlement unexpectedly remained pending");
  }
  return result.value.proof;
};

const installProjectionMigrationDdl = async (): Promise<void> => {
  const migrations = await Promise.all(
    PROJECTION_MIGRATION_URLS.map((migrationUrl) =>
      Bun.file(migrationUrl).text(),
    ),
  );
  const ddls = migrations.flatMap((migration) =>
    migration
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(
        (ddl) =>
          /(?:^|\n)\s*CREATE (?:OR REPLACE )?FUNCTION\b/u.test(ddl) ||
          /(?:^|\n)\s*CREATE TRIGGER\b/u.test(ddl),
      ),
  );
  const executeInOrder = async (index: number): Promise<void> => {
    const ddl = ddls.at(index);
    if (ddl === undefined) {
      return;
    }
    await db.execute(sql.raw(ddl));
    await executeInOrder(index + 1);
  };
  await executeInOrder(0);
};

beforeEach(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await installProjectionMigrationDdl();
  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "projection-store-test",
    name: "Projection store test",
  });
  await db.insert(caseLawDecisions).values({
    id: DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "1 A 1/2026",
    court: "Test court",
    country: "CZE",
    language: "cs",
    contentHash: "c".repeat(64),
    projectionEpoch: 1n,
  });
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: "case_law_v5",
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v5,
    ),
    status: "building",
  });
  await db.insert(corpusIndexProjectionStates).values({
    family: "case_law",
    generation: "case_law_v5",
    entityId: DECISION_ID,
    desiredAction: "upsert",
    desiredEpoch: 1n,
    desiredFingerprint: FIRST_FINGERPRINT,
    desiredIndexId: INDEX_ID,
  });
});

afterEach(async () => {
  await client.close();
});

test("replacement deletes and settles the old revision before reserving the new append", async () => {
  const first = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 10,
        leaseMs: 60_000,
        newIntentId: () => FIRST_INTENT_ID,
        newLeaseToken: () => FIRST_LEASE_TOKEN,
      }),
  );
  expect(first).toHaveLength(1);
  const firstLease = first.at(0) ?? panic("Expected first projection lease");
  expect(
    await db.transaction(
      async (tx) =>
        await startCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: firstLease.intentId,
          leaseToken: firstLease.leaseToken,
        }),
    ),
  ).toBe("started");
  expect(
    await db.transaction(
      async (tx) =>
        await commitCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: firstLease.intentId,
          leaseToken: firstLease.leaseToken,
        }),
    ),
  ).toMatchObject({ status: "applied", entityId: DECISION_ID });

  await db.transaction(async (tx) => {
    await tx
      .update(caseLawDecisions)
      .set({ projectionEpoch: 2n })
      .where(eq(caseLawDecisions.id, DECISION_ID));
    await tx
      .update(corpusIndexProjectionStates)
      .set({
        desiredEpoch: 2n,
        desiredFingerprint: SECOND_FINGERPRINT,
      })
      .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID));
  });

  expect(
    await db.transaction(
      async (tx) =>
        await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
          family: "case_law",
          generation: "case_law_v5",
          limit: 10,
          leaseMs: 60_000,
        }),
    ),
  ).toEqual([]);

  const prepared = await db.transaction(
    async (tx) =>
      await prepareCorpusProjectionReplacementsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 10,
      }),
  );
  expect(prepared.map(({ intentId }) => intentId)).toEqual([
    firstLease.intentId,
  ]);

  const cleanup = await db.transaction(
    async (tx) =>
      await claimCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        indexId: INDEX_ID,
        limit: 10,
        leaseMs: 60_000,
        newLeaseToken: () => CLEANUP_LEASE_TOKEN,
      }),
  );
  expect(cleanup).toHaveLength(1);
  expect(
    await db.transaction(
      async (tx) =>
        await recordCorpusProjectionDeleteTx(asTestRaw<Transaction>(tx), {
          intentIds: [firstLease.intentId],
          indexId: INDEX_ID,
          leaseToken: CLEANUP_LEASE_TOKEN,
          deleteOpstamp: 42,
        }),
    ),
  ).toBe(1);
  const releasedSettlementLease = await db.transaction(
    async (tx) =>
      await claimCorpusProjectionCleanupSettlementTx(
        asTestRaw<Transaction>(tx),
        {
          family: "case_law",
          generation: "case_law_v5",
          indexId: INDEX_ID,
          limit: 10,
          leaseMs: 60_000,
        },
      ),
  );
  if (releasedSettlementLease === null) {
    return panic("Expected a releasable projection settlement lease");
  }
  expect(
    await db.transaction(
      async (tx) =>
        await releaseCorpusProjectionCleanupSettlementTx(
          asTestRaw<Transaction>(tx),
          { lease: releasedSettlementLease },
        ),
    ),
  ).toBe(1);
  const firstSettlementProof = await verifySettlement({
    intentIds: [firstLease.intentId],
    deleteOpstamp: 42,
  });
  expect(
    await db.transaction(
      async (tx) =>
        await settleCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
          proof: firstSettlementProof,
        }),
    ),
  ).toBe(1);

  expect(
    await db.transaction(
      async (tx) =>
        await reopenCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
          intentIds: [firstLease.intentId],
          indexId: INDEX_ID,
          errorMessage: "orphan census observed the settled revision again",
        }),
    ),
  ).toBe(1);
  const reopened = await db
    .select({
      status: corpusIndexProjectionIntents.status,
      deleteOpstamp: corpusIndexProjectionIntents.deleteOpstamp,
      settledAt: corpusIndexProjectionIntents.settledAt,
    })
    .from(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, firstLease.intentId));
  expect(reopened).toEqual([
    { status: "cleanup_pending", deleteOpstamp: null, settledAt: null },
  ]);
  const reclaimed = await db.transaction(
    async (tx) =>
      await claimCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        indexId: INDEX_ID,
        limit: 10,
        leaseMs: 60_000,
        newLeaseToken: () => REOPEN_CLEANUP_LEASE_TOKEN,
      }),
  );
  expect(reclaimed.map(({ intentId }) => intentId)).toEqual([
    firstLease.intentId,
  ]);
  expect(
    await db.transaction(
      async (tx) =>
        await recordCorpusProjectionDeleteTx(asTestRaw<Transaction>(tx), {
          intentIds: [firstLease.intentId],
          indexId: INDEX_ID,
          leaseToken: REOPEN_CLEANUP_LEASE_TOKEN,
          deleteOpstamp: 43,
        }),
    ),
  ).toBe(1);
  const reopenedSettlementProof = await verifySettlement({
    intentIds: [firstLease.intentId],
    deleteOpstamp: 43,
  });
  expect(
    await db.transaction(
      async (tx) =>
        await settleCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
          proof: reopenedSettlementProof,
        }),
    ),
  ).toBe(1);

  const second = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 10,
        leaseMs: 60_000,
        newIntentId: () => SECOND_INTENT_ID,
        newLeaseToken: () => SECOND_LEASE_TOKEN,
      }),
  );
  expect(second).toMatchObject([
    {
      intentId: SECOND_INTENT_ID,
      entityId: DECISION_ID,
      epoch: 2n,
      fingerprint: SECOND_FINGERPRINT,
    },
  ]);

  const statuses = await db
    .select({ status: corpusIndexProjectionIntents.status })
    .from(corpusIndexProjectionIntents)
    .orderBy(corpusIndexProjectionIntents.epoch)
    .limit(2);
  expect(statuses).toEqual([{ status: "settled" }, { status: "reserved" }]);
});

test("production transitions preserve PostgreSQL clock ordering under process skew", async () => {
  const databaseNow = new Date("2031-02-03T04:05:06.000Z");
  expect(databaseNow.getTime()).toBeGreaterThan(Date.now());
  await setDatabaseClock(databaseNow);
  const reservation = await withDatabaseClock(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(tx, {
        family: "case_law",
        generation: "case_law_v5",
        limit: 1,
        leaseMs: 60_000,
        newIntentId: () => FIRST_INTENT_ID,
        newLeaseToken: () => FIRST_LEASE_TOKEN,
      }),
  );
  const lease = reservation.at(0) ?? panic("Expected projection reservation");
  expect(lease.leaseExpiresAt).toEqual(
    new Date(databaseNow.getTime() + 60_000),
  );
  expect(
    await withDatabaseClock(
      async (tx) =>
        await startCorpusProjectionAppendTx(tx, {
          intentId: lease.intentId,
          leaseToken: lease.leaseToken,
        }),
    ),
  ).toBe("started");
  expect(
    await withDatabaseClock(
      async (tx) =>
        await commitCorpusProjectionAppendTx(tx, {
          intentId: lease.intentId,
          leaseToken: lease.leaseToken,
        }),
    ),
  ).toMatchObject({ status: "applied" });

  await db.transaction(async (tx) => {
    await tx
      .update(caseLawDecisions)
      .set({ projectionEpoch: 2n })
      .where(eq(caseLawDecisions.id, DECISION_ID));
    await tx
      .update(corpusIndexProjectionStates)
      .set({
        desiredEpoch: 2n,
        desiredFingerprint: SECOND_FINGERPRINT,
      })
      .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID));
  });
  expect(
    await withDatabaseClock(
      async (tx) =>
        await prepareCorpusProjectionReplacementsTx(tx, {
          family: "case_law",
          generation: "case_law_v5",
          limit: 1,
        }),
    ),
  ).toMatchObject([{ intentId: FIRST_INTENT_ID }]);
  expect(
    await db.transaction(async (tx) => {
      await tx
        .update(caseLawDecisions)
        .set({ court: "Repeated mutation court" })
        .where(eq(caseLawDecisions.id, DECISION_ID));
      return await advanceCorpusProjectionDesiredStateTx(
        asTestRaw<Transaction>(tx),
        { family: "case_law", entityId: DECISION_ID },
      );
    }),
  ).toEqual({ epoch: 3n, generationCount: 1 });
  const cleanup = await withDatabaseClock(
    async (tx) =>
      await claimCorpusProjectionCleanupTx(tx, {
        family: "case_law",
        generation: "case_law_v5",
        indexId: INDEX_ID,
        limit: 1,
        leaseMs: 60_000,
        newLeaseToken: () => CLEANUP_LEASE_TOKEN,
      }),
  );
  expect(cleanup.map(({ intentId }) => intentId)).toEqual([FIRST_INTENT_ID]);
  expect(
    await db.transaction(async (tx) => {
      await tx
        .update(caseLawDecisions)
        .set({ caseNumber: "1 A 2/2026" })
        .where(eq(caseLawDecisions.id, DECISION_ID));
      return await advanceCorpusProjectionDesiredStateTx(
        asTestRaw<Transaction>(tx),
        { family: "case_law", entityId: DECISION_ID },
      );
    }),
  ).toEqual({ epoch: 4n, generationCount: 1 });
  expect(
    await withDatabaseClock(
      async (tx) =>
        await recordCorpusProjectionDeleteTx(tx, {
          intentIds: [FIRST_INTENT_ID],
          indexId: INDEX_ID,
          leaseToken: CLEANUP_LEASE_TOKEN,
          deleteOpstamp: 60,
        }),
    ),
  ).toBe(1);
  const firstSettlement = await withDatabaseClock(
    async (tx) =>
      await claimCorpusProjectionCleanupSettlementTx(tx, {
        family: "case_law",
        generation: "case_law_v5",
        indexId: INDEX_ID,
        limit: 1,
        leaseMs: 60_000,
        newLeaseToken: () => SECOND_LEASE_TOKEN,
      }),
  );
  if (firstSettlement === null) {
    return panic("Expected first settlement lease");
  }
  expect(
    await withDatabaseClock(
      async (tx) =>
        await releaseCorpusProjectionCleanupSettlementTx(tx, {
          lease: firstSettlement,
        }),
    ),
  ).toBe(1);
  const settlement = await withDatabaseClock(
    async (tx) =>
      await claimCorpusProjectionCleanupSettlementTx(tx, {
        family: "case_law",
        generation: "case_law_v5",
        indexId: INDEX_ID,
        limit: 1,
        leaseMs: 60_000,
        newLeaseToken: () => REOPEN_CLEANUP_LEASE_TOKEN,
      }),
  );
  if (settlement === null) {
    return panic("Expected settlement lease");
  }
  const verified = await CorpusProjectionCleanupSettlementProof.verify({
    client: settledProjectionClient,
    lease: settlement,
  });
  if (verified.isErr()) {
    return panic("Expected successful settlement verification");
  }
  if (verified.value.status !== "verified") {
    return panic("Expected verified settlement proof");
  }
  expect(
    await withDatabaseClock(
      async (tx) =>
        await settleCorpusProjectionCleanupTx(tx, {
          proof: verified.value.proof,
        }),
    ),
  ).toBe(1);
  expect(
    await withDatabaseClock(
      async (tx) =>
        await reopenCorpusProjectionCleanupTx(tx, {
          intentIds: [FIRST_INTENT_ID],
          indexId: INDEX_ID,
          errorMessage: "census found the revision after settlement",
        }),
    ),
  ).toBe(1);
  expect(
    await withDatabaseClock(
      async (tx) =>
        await claimCorpusProjectionCleanupTx(tx, {
          family: "case_law",
          generation: "case_law_v5",
          indexId: INDEX_ID,
          limit: 1,
          leaseMs: 60_000,
          newLeaseToken: () => ERASE_CLEANUP_TOKEN,
        }),
    ),
  ).toHaveLength(1);

  const recoveryNow = new Date(databaseNow.getTime() + 2 * 60_000);
  await setDatabaseClock(recoveryNow);
  expect(
    await withDatabaseClock(
      async (tx) =>
        await recoverExpiredCorpusProjectionIntentsTx(tx, {
          family: "case_law",
          generation: "case_law_v5",
          limit: 1,
        }),
    ),
  ).toEqual([{ intentId: FIRST_INTENT_ID, status: "cleanup_started" }]);

  const rows = await db
    .select({
      status: corpusIndexProjectionIntents.status,
      appendStartedAt: corpusIndexProjectionIntents.appendStartedAt,
      appendCommittedAt: corpusIndexProjectionIntents.appendCommittedAt,
      appliedAt: corpusIndexProjectionIntents.appliedAt,
      appendPublishBarrierAt:
        corpusIndexProjectionIntents.appendPublishBarrierAt,
      cleanupNotBefore: corpusIndexProjectionIntents.cleanupNotBefore,
      cleanupStartedAt: corpusIndexProjectionIntents.cleanupStartedAt,
      settledAt: corpusIndexProjectionIntents.settledAt,
      updatedAt: corpusIndexProjectionIntents.updatedAt,
    })
    .from(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, FIRST_INTENT_ID));
  expect(rows).toEqual([
    {
      status: "cleanup_pending",
      appendStartedAt: databaseNow,
      appendCommittedAt: databaseNow,
      appliedAt: databaseNow,
      appendPublishBarrierAt: databaseNow,
      cleanupNotBefore: databaseNow,
      cleanupStartedAt: null,
      settledAt: null,
      updatedAt: recoveryNow,
    },
  ]);
  const state = await db
    .select({ appliedAt: corpusIndexProjectionStates.appliedAt })
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID));
  expect(state).toEqual([{ appliedAt: databaseNow }]);
});

test("a settled same-epoch attempt reopens after its retry is applied", async () => {
  const appendStartedAt = new Date(Date.now() - 10 * 60_000);
  const first = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 1,
        leaseMs: 60_000,
        testNow: appendStartedAt,
        newIntentId: () => FIRST_INTENT_ID,
        newLeaseToken: () => FIRST_LEASE_TOKEN,
      }),
  );
  const firstLease = first.at(0) ?? panic("Expected first projection lease");
  expect(
    await db.transaction(
      async (tx) =>
        await startCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: firstLease.intentId,
          leaseToken: firstLease.leaseToken,
          testNow: appendStartedAt,
        }),
    ),
  ).toBe("started");
  expect(
    await db.transaction(
      async (tx) =>
        await abandonCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: firstLease.intentId,
          leaseToken: firstLease.leaseToken,
          errorMessage: "append response was lost",
        }),
    ),
  ).toBe("cleanup_pending");
  const firstCleanup = await db.transaction(
    async (tx) =>
      await claimCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        indexId: INDEX_ID,
        limit: 1,
        leaseMs: 60_000,
        newLeaseToken: () => CLEANUP_LEASE_TOKEN,
      }),
  );
  expect(firstCleanup.map(({ intentId }) => intentId)).toEqual([
    FIRST_INTENT_ID,
  ]);
  await db.transaction(
    async (tx) =>
      await recordCorpusProjectionDeleteTx(asTestRaw<Transaction>(tx), {
        intentIds: [FIRST_INTENT_ID],
        indexId: INDEX_ID,
        leaseToken: CLEANUP_LEASE_TOKEN,
        deleteOpstamp: 50,
      }),
  );
  const firstProof = await verifySettlement({
    intentIds: [FIRST_INTENT_ID],
    deleteOpstamp: 50,
  });
  await db.transaction(
    async (tx) =>
      await settleCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
        proof: firstProof,
      }),
  );

  const retry = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 1,
        leaseMs: 60_000,
        newIntentId: () => SECOND_INTENT_ID,
        newLeaseToken: () => SECOND_LEASE_TOKEN,
      }),
  );
  const retryLease = retry.at(0) ?? panic("Expected retry projection lease");
  expect(retryLease.epoch).toBe(firstLease.epoch);
  expect(
    await db.transaction(
      async (tx) =>
        await startCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: retryLease.intentId,
          leaseToken: retryLease.leaseToken,
        }),
    ),
  ).toBe("started");
  expect(
    await db.transaction(
      async (tx) =>
        await commitCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: retryLease.intentId,
          leaseToken: retryLease.leaseToken,
        }),
    ),
  ).toMatchObject({ status: "applied" });

  expect(
    await db.transaction(
      async (tx) =>
        await reopenCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
          intentIds: [FIRST_INTENT_ID],
          indexId: INDEX_ID,
          errorMessage: "census found the old same-epoch attempt",
        }),
    ),
  ).toBe(1);
  const attempts = await db
    .select({
      id: corpusIndexProjectionIntents.id,
      epoch: corpusIndexProjectionIntents.epoch,
      status: corpusIndexProjectionIntents.status,
    })
    .from(corpusIndexProjectionIntents)
    .orderBy(corpusIndexProjectionIntents.id);
  expect(attempts).toEqual([
    { id: FIRST_INTENT_ID, epoch: 1n, status: "cleanup_pending" },
    { id: SECOND_INTENT_ID, epoch: 1n, status: "applied" },
  ]);
});

test("erasure fences an unknown append and applies only after cleanup settlement", async () => {
  await db.insert(caseLawDecisions).values({
    id: ERASE_DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "1 A 2/2026",
    court: "Test court",
    country: "CZE",
    language: "cs",
    contentHash: "d".repeat(64),
    projectionEpoch: 1n,
  });
  await db.insert(corpusIndexProjectionStates).values({
    family: "case_law",
    generation: "case_law_v5",
    entityId: ERASE_DECISION_ID,
    desiredAction: "upsert",
    desiredEpoch: 1n,
    desiredFingerprint: FIRST_FINGERPRINT,
    desiredIndexId: INDEX_ID,
  });
  const startedAt = new Date(Date.now() - 10 * 60_000);
  const intentIds = [FIRST_INTENT_ID, ERASE_INTENT_ID][Symbol.iterator]();
  const leaseTokens = [FIRST_LEASE_TOKEN, ERASE_LEASE_TOKEN][Symbol.iterator]();
  const leases = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 10,
        leaseMs: 60_000,
        testNow: startedAt,
        newIntentId: () =>
          intentIds.next().value ?? panic("Unexpected projection candidate"),
        newLeaseToken: () =>
          leaseTokens.next().value ?? panic("Unexpected projection candidate"),
      }),
  );
  const lease =
    leases.find(({ entityId }) => entityId === ERASE_DECISION_ID) ??
    panic("Expected erasure projection lease");
  expect(lease.leaseExpiresAt).toEqual(new Date(startedAt.getTime() + 60_000));
  expect(
    await db.transaction(
      async (tx) =>
        await startCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: lease.intentId,
          leaseToken: lease.leaseToken,
          testNow: startedAt,
        }),
    ),
  ).toBe("started");

  await db.transaction(async (tx) => {
    await tx
      .update(caseLawDecisions)
      .set({ projectionEpoch: 2n })
      .where(eq(caseLawDecisions.id, ERASE_DECISION_ID));
    await tx
      .update(corpusIndexProjectionStates)
      .set({
        desiredAction: "erase",
        desiredEpoch: 2n,
        desiredFingerprint: null,
        desiredIndexId: null,
      })
      .where(eq(corpusIndexProjectionStates.entityId, ERASE_DECISION_ID));
  });

  const erasureNow = new Date("2032-03-04T05:06:07.000Z");
  await setDatabaseClock(erasureNow);
  const fenced = await withDatabaseClock(
    async (tx) =>
      await advanceCorpusProjectionErasuresTx(tx, {
        family: "case_law",
        generation: "case_law_v5",
        limit: 10,
      }),
  );
  expect(fenced).toMatchObject({
    scheduledRevisions: [lease.intentId],
    appliedEntityIds: [],
  });
  const fencedIntent = await db
    .select({ updatedAt: corpusIndexProjectionIntents.updatedAt })
    .from(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, lease.intentId));
  expect(fencedIntent).toEqual([{ updatedAt: erasureNow }]);

  const cleanup = await db.transaction(
    async (tx) =>
      await claimCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        indexId: INDEX_ID,
        limit: 10,
        leaseMs: 60_000,
        newLeaseToken: () => ERASE_CLEANUP_TOKEN,
      }),
  );
  expect(cleanup.map(({ intentId }) => intentId)).toContain(lease.intentId);
  expect(
    await db.transaction(
      async (tx) =>
        await recordCorpusProjectionDeleteTx(asTestRaw<Transaction>(tx), {
          intentIds: [lease.intentId],
          indexId: INDEX_ID,
          leaseToken: ERASE_CLEANUP_TOKEN,
          deleteOpstamp: 43,
        }),
    ),
  ).toBe(1);
  const erasureSettlementProof = await verifySettlement({
    intentIds: [lease.intentId],
    deleteOpstamp: 43,
  });
  expect(
    await db.transaction(
      async (tx) =>
        await settleCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
          proof: erasureSettlementProof,
        }),
    ),
  ).toBe(1);

  const applied = await withDatabaseClock(
    async (tx) =>
      await advanceCorpusProjectionErasuresTx(tx, {
        family: "case_law",
        generation: "case_law_v5",
        limit: 10,
      }),
  );
  expect(applied.appliedEntityIds).toEqual([ERASE_DECISION_ID]);
  const state = await db
    .select({
      action: corpusIndexProjectionStates.appliedAction,
      epoch: corpusIndexProjectionStates.appliedEpoch,
      revision: corpusIndexProjectionStates.appliedRevision,
      appliedAt: corpusIndexProjectionStates.appliedAt,
    })
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, ERASE_DECISION_ID));
  expect(state).toEqual([
    { action: "erase", epoch: 2n, revision: null, appliedAt: erasureNow },
  ]);
});

test("cleanup-owned revisions do not consume the erasure action cap", async () => {
  await db.insert(caseLawDecisions).values({
    id: ERASE_DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "1 A 3/2026",
    court: "Test court",
    country: "CZE",
    language: "cs",
    contentHash: "e".repeat(64),
    projectionEpoch: 1n,
  });
  await db.insert(corpusIndexProjectionStates).values({
    family: "case_law",
    generation: "case_law_v5",
    entityId: ERASE_DECISION_ID,
    desiredAction: "erase",
    desiredEpoch: 1n,
  });
  const cleanupIds = Array.from(
    { length: CORPUS_PROJECTION_ERASURE_MAX_REVISIONS },
    (_, index) =>
      toSafeId<"corpusIndexProjectionIntent">(
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      ),
  );
  const appendStartedAt = new Date(Date.now() - 60_000);
  await db.execute(
    sql`ALTER TABLE corpus_index_projection_intents DISABLE TRIGGER corpus_index_projection_intents_insert_guard`,
  );
  await db.insert(corpusIndexProjectionIntents).values([
    ...cleanupIds.map(
      (id) =>
        ({
          id,
          family: "case_law",
          generation: "case_law_v5",
          entityId: ERASE_DECISION_ID,
          epoch: 1n,
          fingerprint: FIRST_FINGERPRINT,
          indexId: INDEX_ID,
          status: "cleanup_pending",
          appendStartedAt,
          appendPublishBarrierAt: appendStartedAt,
          cleanupNotBefore: appendStartedAt,
        }) satisfies typeof corpusIndexProjectionIntents.$inferInsert,
    ),
    {
      id: ERASE_INTENT_ID,
      family: "case_law",
      generation: "case_law_v5",
      entityId: ERASE_DECISION_ID,
      epoch: 1n,
      fingerprint: FIRST_FINGERPRINT,
      indexId: INDEX_ID,
      status: "reserved",
      leaseToken: ERASE_LEASE_TOKEN,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    },
  ]);
  await db.execute(
    sql`ALTER TABLE corpus_index_projection_intents ENABLE TRIGGER corpus_index_projection_intents_insert_guard`,
  );

  const result = await db.transaction(
    async (tx) =>
      await advanceCorpusProjectionErasuresTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 1,
      }),
  );
  expect(result).toMatchObject({
    claimedCount: 1,
    cancelledRevisions: [ERASE_INTENT_ID],
    scheduledRevisions: [],
    appliedEntityIds: [],
  });
  const actionable = await db
    .select({ status: corpusIndexProjectionIntents.status })
    .from(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, ERASE_INTENT_ID));
  expect(actionable).toEqual([{ status: "cancelled" }]);
});

test("cleanup claim and settlement phases have bounded partial access paths", async () => {
  const indexes = await client.query<{ indexdef: string; indexname: string }>(`
    SELECT indexname, indexdef
    FROM pg_indexes
    WHERE indexname IN (
      'corpus_index_projection_intents_cleanup_claim_idx',
      'corpus_index_projection_intents_settlement_next_idx',
      'corpus_index_projection_intents_settlement_batch_idx'
    )
    ORDER BY indexname
  `);
  const definitions = new Map(
    indexes.rows.map(({ indexdef, indexname }) => [indexname, indexdef]),
  );
  expect(
    definitions.get("corpus_index_projection_intents_cleanup_claim_idx"),
  ).toContain(
    "(family, generation, index_id, status, cleanup_not_before, created_at)",
  );
  expect(
    definitions.get("corpus_index_projection_intents_cleanup_claim_idx"),
  ).toContain("WHERE (status = 'cleanup_pending'::text)");
  expect(
    definitions.get("corpus_index_projection_intents_settlement_next_idx"),
  ).toContain(
    "(family, generation, index_id, status, cleanup_started_at, created_at)",
  );
  expect(
    definitions.get("corpus_index_projection_intents_settlement_batch_idx"),
  ).toContain(
    "(family, generation, index_id, status, delete_opstamp, created_at)",
  );
  for (const indexName of [
    "corpus_index_projection_intents_settlement_next_idx",
    "corpus_index_projection_intents_settlement_batch_idx",
  ]) {
    const definition = definitions.get(indexName);
    expect(definition).toContain("WHERE (status = 'cleanup_committed'::text)");
  }
  expect(definitions.size).toBe(3);
});
