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
  claimCorpusProjectionCleanupTx,
  CorpusProjectionCleanupSettlementProof,
  recordCorpusProjectionDeleteTx,
  settleCorpusProjectionCleanupTx,
} from "@/api/lib/legal-search/corpus-index-projection-cleanup-store";
import { advanceCorpusProjectionErasuresTx } from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import {
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
    "../../../drizzle/20260825143000_corpus_projection_replacement_order/migration.sql",
    import.meta.url,
  ),
] as const;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

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
  const result = await CorpusProjectionCleanupSettlementProof.verify({
    client: settledProjectionClient,
    indexId: INDEX_ID,
    intentIds,
    deleteOpstamp,
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
  const leases = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 10,
        leaseMs: 60_000,
        now: startedAt,
        newIntentId: () => ERASE_INTENT_ID,
        newLeaseToken: () => ERASE_LEASE_TOKEN,
      }),
  );
  const lease =
    leases.find(({ entityId }) => entityId === ERASE_DECISION_ID) ??
    panic("Expected erasure projection lease");
  expect(
    await db.transaction(
      async (tx) =>
        await startCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: lease.intentId,
          leaseToken: lease.leaseToken,
          now: startedAt,
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

  const fenced = await db.transaction(
    async (tx) =>
      await advanceCorpusProjectionErasuresTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 10,
      }),
  );
  expect(fenced).toMatchObject({
    scheduledRevisions: [lease.intentId],
    appliedEntityIds: [],
  });

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

  const applied = await db.transaction(
    async (tx) =>
      await advanceCorpusProjectionErasuresTx(asTestRaw<Transaction>(tx), {
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
    })
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, ERASE_DECISION_ID));
  expect(state).toEqual([{ action: "erase", epoch: 2n, revision: null }]);
});
