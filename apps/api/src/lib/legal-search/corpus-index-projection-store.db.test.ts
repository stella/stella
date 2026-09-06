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
import { censusAppliedCorpusProjections } from "@/api/lib/legal-search/corpus-index-projection-census";
import {
  readAppliedCorpusProjectionCensusPageTx,
  readSettledCorpusProjectionCensusPageTx,
  repairAppliedCorpusProjectionDriftTx,
  revalidateAppliedCorpusProjectionCensusTx,
} from "@/api/lib/legal-search/corpus-index-projection-census-store";
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
  corpusIndexAppendPublishDelayMs,
  corpusIndexUnknownAppendBarrierAt,
} from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  advanceCorpusProjectionErasuresTx,
  CORPUS_PROJECTION_ERASURE_MAX_REVISIONS,
} from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import {
  abandonCorpusProjectionAppendTx,
  classifyCorpusProjectionReservationFailureTx,
  commitCorpusProjectionAppendTx,
  prepareCorpusProjectionReplacementsTx,
  reserveCorpusProjectionIntentsTx,
  startCorpusProjectionAppendBatchTx,
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
const POL_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000214",
);
const POL_INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000215",
);
const POL_LEASE_TOKEN = "0198e331-e578-7000-8000-000000000216";
const ERASE_READY_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-000000000213",
);
const ERASE_INTENT_ID = toSafeId<"corpusIndexProjectionIntent">(
  "0198e331-e578-7000-8000-000000000209",
);
const ERASE_LEASE_TOKEN = "0198e331-e578-7000-8000-000000000210";
const ERASE_CLEANUP_TOKEN = "0198e331-e578-7000-8000-000000000211";
const FIRST_FINGERPRINT = "a".repeat(64);
const SECOND_FINGERPRINT = "b".repeat(64);
const INDEX_ID = "case_law_v5_cs_sk";
const POL_INDEX_ID = "case_law_v5_pol";
const INITIAL_RUNNABLE_AT = new Date("2026-08-25T00:00:00.000Z");
const DRIZZLE_DIR = new URL("../../../drizzle/", import.meta.url);

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
    return panic("Projection settlement verification failed", result.error);
  }
  if (result.value.status !== "verified") {
    return panic("Projection settlement unexpectedly remained pending");
  }
  return result.value.proof;
};

const installProjectionMigrationDdl = async (): Promise<void> => {
  const projectionMigrations = [
    ...new Bun.Glob("*corpus*projection*/migration.sql").scanSync(
      Bun.fileURLToPath(DRIZZLE_DIR),
    ),
  ]
    .filter((migration) => !migration.includes("projection_revision"))
    .sort();
  const migrations = await Promise.all(
    projectionMigrations.map(
      async (migration) =>
        await Bun.file(new URL(migration, DRIZZLE_DIR)).text(),
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
    updatedAt: INITIAL_RUNNABLE_AT,
  });
});

afterEach(async () => {
  await client.close();
});

test("a subject-scoped reservation cannot claim another pending decision", async () => {
  await db.insert(caseLawDecisions).values({
    id: ERASE_DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "2 A 2/2026",
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
    desiredFingerprint: SECOND_FINGERPRINT,
    desiredIndexId: INDEX_ID,
    updatedAt: INITIAL_RUNNABLE_AT,
  });

  const leases = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        scope: { type: "subjects", entityIds: [ERASE_DECISION_ID] },
        limit: 10,
        leaseMs: 60_000,
        newIntentId: () => FIRST_INTENT_ID,
        newLeaseToken: () => FIRST_LEASE_TOKEN,
      }),
  );

  expect(leases.map(({ entityId }) => entityId)).toEqual([ERASE_DECISION_ID]);
  expect(
    await db
      .select({ entityId: corpusIndexProjectionIntents.entityId })
      .from(corpusIndexProjectionIntents),
  ).toEqual([{ entityId: ERASE_DECISION_ID }]);
});

test("a route-scoped reservation claims only its desired physical index", async () => {
  await db.insert(caseLawDecisions).values({
    id: POL_DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "III SA/Wa 1/2026",
    court: "Test court",
    country: "POL",
    language: "pl",
    contentHash: "d".repeat(64),
    projectionEpoch: 1n,
  });
  await db.insert(corpusIndexProjectionStates).values({
    family: "case_law",
    generation: "case_law_v5",
    entityId: POL_DECISION_ID,
    desiredAction: "upsert",
    desiredEpoch: 1n,
    desiredFingerprint: SECOND_FINGERPRINT,
    desiredIndexId: POL_INDEX_ID,
    updatedAt: INITIAL_RUNNABLE_AT,
  });

  const leases = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        scope: { type: "route", indexId: POL_INDEX_ID },
        limit: 10,
        leaseMs: 60_000,
        newIntentId: () => POL_INTENT_ID,
        newLeaseToken: () => POL_LEASE_TOKEN,
      }),
  );

  expect(
    leases.map(({ entityId, indexId }) => ({ entityId, indexId })),
  ).toEqual([{ entityId: POL_DECISION_ID, indexId: POL_INDEX_ID }]);
  expect(
    await db
      .select({ entityId: corpusIndexProjectionIntents.entityId })
      .from(corpusIndexProjectionIntents),
  ).toEqual([{ entityId: POL_DECISION_ID }]);
});

test("a reservation that loses the append-epoch election returns no lease", async () => {
  await db.execute(
    sql.raw(`
      CREATE FUNCTION inject_competing_projection_reservation()
      RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF pg_trigger_depth() = 1 THEN
          INSERT INTO corpus_index_projection_intents (
            id,
            family,
            generation,
            entity_id,
            epoch,
            fingerprint,
            index_id,
            status,
            lease_token,
            lease_expires_at
          ) VALUES (
            '${SECOND_INTENT_ID}',
            NEW.family,
            NEW.generation,
            NEW.entity_id,
            NEW.epoch,
            NEW.fingerprint,
            NEW.index_id,
            'reserved',
            '${SECOND_LEASE_TOKEN}',
            NEW.lease_expires_at
          );
        END IF;
        RETURN NEW;
      END;
      $$;
    `),
  );
  await db.execute(
    sql.raw(`
      CREATE TRIGGER inject_competing_projection_reservation
      BEFORE INSERT ON corpus_index_projection_intents
      FOR EACH ROW
      EXECUTE FUNCTION inject_competing_projection_reservation();
    `),
  );

  const leases = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 1,
        leaseMs: 60_000,
        newIntentId: () => FIRST_INTENT_ID,
        newLeaseToken: () => FIRST_LEASE_TOKEN,
      }),
  );

  expect(leases).toEqual([]);
  expect(
    await db
      .select({ id: corpusIndexProjectionIntents.id })
      .from(corpusIndexProjectionIntents),
  ).toEqual([{ id: SECOND_INTENT_ID }]);
});

test("an unregistered route fails before reservation mutates state", async () => {
  // bun-types declares `.rejects.toThrow` as void, so awaiting it trips
  // type-aware lint; capture the rejection explicitly instead.
  const rejection: unknown = await db
    .transaction(async (tx) =>
      reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        scope: { type: "route", indexId: "case_law_v5_hun" },
        limit: 10,
        leaseMs: 60_000,
      }),
    )
    .then(
      () => null,
      (error: unknown) => error,
    );
  expect(rejection).toMatchObject({
    message:
      "Corpus index id is not a manifest route: case_law_v5/case_law_v5_hun",
  });
  expect(await db.select().from(corpusIndexProjectionIntents)).toEqual([]);
});

test("a subject-scoped erasure cannot apply another erased decision", async () => {
  await db.insert(caseLawDecisions).values({
    id: ERASE_DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "2 A 2/2026",
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
    desiredAction: "erase",
    desiredEpoch: 1n,
    updatedAt: INITIAL_RUNNABLE_AT,
  });
  await db
    .update(caseLawDecisions)
    .set({ projectionEpoch: 2n })
    .where(eq(caseLawDecisions.id, DECISION_ID));
  await db
    .update(corpusIndexProjectionStates)
    .set({
      desiredAction: "erase",
      desiredEpoch: 2n,
      desiredFingerprint: null,
      desiredIndexId: null,
    })
    .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID));

  const result = await db.transaction(
    async (tx) =>
      await advanceCorpusProjectionErasuresTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        scope: { type: "subjects", entityIds: [ERASE_DECISION_ID] },
        limit: 10,
      }),
  );

  expect(result.appliedEntityIds).toEqual([ERASE_DECISION_ID]);
  expect(
    await db
      .select({
        entityId: corpusIndexProjectionStates.entityId,
        appliedAction: corpusIndexProjectionStates.appliedAction,
      })
      .from(corpusIndexProjectionStates)
      .orderBy(corpusIndexProjectionStates.entityId),
  ).toEqual([
    { entityId: DECISION_ID, appliedAction: null },
    { entityId: ERASE_DECISION_ID, appliedAction: "erase" },
  ]);
});

test("subject-scoped cleanup and settlement cannot claim another revision", async () => {
  const cleanupAt = new Date("2026-08-25T00:00:00.000Z");
  await db.insert(caseLawDecisions).values({
    id: ERASE_DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "2 A 2/2026",
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
    desiredFingerprint: SECOND_FINGERPRINT,
    desiredIndexId: INDEX_ID,
    updatedAt: INITIAL_RUNNABLE_AT,
  });
  await db.execute(
    sql`ALTER TABLE corpus_index_projection_intents DISABLE TRIGGER corpus_index_projection_intents_insert_guard`,
  );
  await db.insert(corpusIndexProjectionIntents).values([
    {
      id: FIRST_INTENT_ID,
      family: "case_law",
      generation: "case_law_v5",
      entityId: DECISION_ID,
      epoch: 1n,
      fingerprint: FIRST_FINGERPRINT,
      indexId: INDEX_ID,
      status: "cleanup_pending",
      appendStartedAt: cleanupAt,
      appendPublishBarrierAt: cleanupAt,
      cleanupNotBefore: cleanupAt,
    },
    {
      id: SECOND_INTENT_ID,
      family: "case_law",
      generation: "case_law_v5",
      entityId: ERASE_DECISION_ID,
      epoch: 1n,
      fingerprint: SECOND_FINGERPRINT,
      indexId: INDEX_ID,
      status: "cleanup_pending",
      appendStartedAt: cleanupAt,
      appendPublishBarrierAt: cleanupAt,
      cleanupNotBefore: cleanupAt,
    },
  ]);
  await db.execute(
    sql`ALTER TABLE corpus_index_projection_intents ENABLE TRIGGER corpus_index_projection_intents_insert_guard`,
  );

  const cleanup = await db.transaction(
    async (tx) =>
      await claimCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        indexId: INDEX_ID,
        scope: { type: "subjects", entityIds: [ERASE_DECISION_ID] },
        limit: 10,
        leaseMs: 60_000,
        newLeaseToken: () => CLEANUP_LEASE_TOKEN,
      }),
  );
  expect(cleanup.map(({ intentId }) => intentId)).toEqual([SECOND_INTENT_ID]);
  await db.transaction(
    async (tx) =>
      await recordCorpusProjectionDeleteTx(asTestRaw<Transaction>(tx), {
        intentIds: [SECOND_INTENT_ID],
        indexId: INDEX_ID,
        leaseToken: CLEANUP_LEASE_TOKEN,
        deleteOpstamp: 42,
      }),
  );

  const settlement = await db.transaction(
    async (tx) =>
      await claimCorpusProjectionCleanupSettlementTx(
        asTestRaw<Transaction>(tx),
        {
          family: "case_law",
          generation: "case_law_v5",
          indexId: INDEX_ID,
          scope: { type: "subjects", entityIds: [ERASE_DECISION_ID] },
          limit: 10,
          leaseMs: 60_000,
          newLeaseToken: () => ERASE_CLEANUP_TOKEN,
        },
      ),
  );
  expect(settlement?.intentIds).toEqual([SECOND_INTENT_ID]);
  expect(
    await db
      .select({
        id: corpusIndexProjectionIntents.id,
        status: corpusIndexProjectionIntents.status,
      })
      .from(corpusIndexProjectionIntents)
      .orderBy(corpusIndexProjectionIntents.id),
  ).toEqual([
    { id: FIRST_INTENT_ID, status: "cleanup_pending" },
    { id: SECOND_INTENT_ID, status: "cleanup_committed" },
  ]);
});

test("subject-scoped recovery cannot cancel another expired reservation", async () => {
  const expiredAt = new Date("2026-08-25T00:00:00.000Z");
  await db.insert(caseLawDecisions).values({
    id: ERASE_DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "2 A 2/2026",
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
    desiredFingerprint: SECOND_FINGERPRINT,
    desiredIndexId: INDEX_ID,
    updatedAt: INITIAL_RUNNABLE_AT,
  });
  await db.insert(corpusIndexProjectionIntents).values([
    {
      id: FIRST_INTENT_ID,
      family: "case_law",
      generation: "case_law_v5",
      entityId: DECISION_ID,
      epoch: 1n,
      fingerprint: FIRST_FINGERPRINT,
      indexId: INDEX_ID,
      status: "reserved",
      leaseToken: FIRST_LEASE_TOKEN,
      leaseExpiresAt: expiredAt,
    },
    {
      id: SECOND_INTENT_ID,
      family: "case_law",
      generation: "case_law_v5",
      entityId: ERASE_DECISION_ID,
      epoch: 1n,
      fingerprint: SECOND_FINGERPRINT,
      indexId: INDEX_ID,
      status: "reserved",
      leaseToken: SECOND_LEASE_TOKEN,
      leaseExpiresAt: expiredAt,
    },
  ]);

  const recovered = await db.transaction(
    async (tx) =>
      await recoverExpiredCorpusProjectionIntentsTx(
        asTestRaw<Transaction>(tx),
        {
          family: "case_law",
          generation: "case_law_v5",
          scope: { type: "subjects", entityIds: [ERASE_DECISION_ID] },
          limit: 10,
        },
      ),
  );

  expect(recovered).toEqual([
    { intentId: SECOND_INTENT_ID, status: "reserved" },
  ]);
  expect(
    await db
      .select({
        id: corpusIndexProjectionIntents.id,
        status: corpusIndexProjectionIntents.status,
      })
      .from(corpusIndexProjectionIntents)
      .orderBy(corpusIndexProjectionIntents.id),
  ).toEqual([
    { id: FIRST_INTENT_ID, status: "reserved" },
    { id: SECOND_INTENT_ID, status: "cancelled" },
  ]);
});

test("subject-scoped replacement cannot retire another applied revision", async () => {
  const appliedAt = new Date("2026-08-25T00:00:00.000Z");
  await db.insert(caseLawDecisions).values({
    id: ERASE_DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "2 A 2/2026",
    court: "Test court",
    country: "CZE",
    language: "cs",
    contentHash: "d".repeat(64),
    projectionEpoch: 2n,
  });
  await db.execute(
    sql`ALTER TABLE corpus_index_projection_intents DISABLE TRIGGER corpus_index_projection_intents_insert_guard`,
  );
  await db.insert(corpusIndexProjectionIntents).values([
    {
      id: FIRST_INTENT_ID,
      family: "case_law",
      generation: "case_law_v5",
      entityId: DECISION_ID,
      epoch: 1n,
      fingerprint: FIRST_FINGERPRINT,
      indexId: INDEX_ID,
      status: "applied",
      appendStartedAt: appliedAt,
      appendCommittedAt: appliedAt,
      expectedDocumentCount: 1,
      appliedAt,
    },
    {
      id: SECOND_INTENT_ID,
      family: "case_law",
      generation: "case_law_v5",
      entityId: ERASE_DECISION_ID,
      epoch: 1n,
      fingerprint: FIRST_FINGERPRINT,
      indexId: INDEX_ID,
      status: "applied",
      appendStartedAt: appliedAt,
      appendCommittedAt: appliedAt,
      expectedDocumentCount: 1,
      appliedAt,
    },
  ]);
  await db.execute(
    sql`ALTER TABLE corpus_index_projection_intents ENABLE TRIGGER corpus_index_projection_intents_insert_guard`,
  );
  await db
    .update(caseLawDecisions)
    .set({ projectionEpoch: 2n })
    .where(eq(caseLawDecisions.id, DECISION_ID));
  await db
    .update(corpusIndexProjectionStates)
    .set({
      desiredEpoch: 2n,
      desiredFingerprint: SECOND_FINGERPRINT,
      appliedAction: "upsert",
      appliedEpoch: 1n,
      appliedRevision: FIRST_INTENT_ID,
      appliedFingerprint: FIRST_FINGERPRINT,
      appliedIndexId: INDEX_ID,
      appliedAt,
    })
    .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID));
  await db.insert(corpusIndexProjectionStates).values({
    family: "case_law",
    generation: "case_law_v5",
    entityId: ERASE_DECISION_ID,
    desiredAction: "upsert",
    desiredEpoch: 2n,
    desiredFingerprint: SECOND_FINGERPRINT,
    desiredIndexId: INDEX_ID,
    appliedAction: "upsert",
    appliedEpoch: 1n,
    appliedRevision: SECOND_INTENT_ID,
    appliedFingerprint: FIRST_FINGERPRINT,
    appliedIndexId: INDEX_ID,
    appliedAt,
    updatedAt: INITIAL_RUNNABLE_AT,
  });

  const replacements = await db.transaction(
    async (tx) =>
      await prepareCorpusProjectionReplacementsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        scope: { type: "subjects", entityIds: [ERASE_DECISION_ID] },
        limit: 10,
      }),
  );

  expect(replacements.map(({ intentId }) => intentId)).toEqual([
    SECOND_INTENT_ID,
  ]);
  expect(
    await db
      .select({
        id: corpusIndexProjectionIntents.id,
        status: corpusIndexProjectionIntents.status,
      })
      .from(corpusIndexProjectionIntents)
      .orderBy(corpusIndexProjectionIntents.id),
  ).toEqual([
    { id: FIRST_INTENT_ID, status: "applied" },
    { id: SECOND_INTENT_ID, status: "cleanup_pending" },
  ]);
});

test("a rerouted replacement is owned by its desired route", async () => {
  const appliedAt = new Date("2026-08-25T00:00:00.000Z");
  await db.execute(
    sql`ALTER TABLE corpus_index_projection_intents DISABLE TRIGGER corpus_index_projection_intents_insert_guard`,
  );
  await db.insert(corpusIndexProjectionIntents).values({
    id: FIRST_INTENT_ID,
    family: "case_law",
    generation: "case_law_v5",
    entityId: DECISION_ID,
    epoch: 1n,
    fingerprint: FIRST_FINGERPRINT,
    indexId: INDEX_ID,
    status: "applied",
    appendStartedAt: appliedAt,
    appendCommittedAt: appliedAt,
    expectedDocumentCount: 1,
    appliedAt,
  });
  await db.execute(
    sql`ALTER TABLE corpus_index_projection_intents ENABLE TRIGGER corpus_index_projection_intents_insert_guard`,
  );
  await db
    .update(caseLawDecisions)
    .set({ projectionEpoch: 2n })
    .where(eq(caseLawDecisions.id, DECISION_ID));
  await db
    .update(corpusIndexProjectionStates)
    .set({
      desiredEpoch: 2n,
      desiredFingerprint: SECOND_FINGERPRINT,
      desiredIndexId: POL_INDEX_ID,
      appliedAction: "upsert",
      appliedEpoch: 1n,
      appliedRevision: FIRST_INTENT_ID,
      appliedFingerprint: FIRST_FINGERPRINT,
      appliedIndexId: INDEX_ID,
      appliedAt,
    })
    .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID));

  const replacements = await db.transaction(
    async (tx) =>
      await prepareCorpusProjectionReplacementsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        scope: { type: "route", indexId: POL_INDEX_ID },
        limit: 10,
      }),
  );

  expect(replacements).toEqual([
    {
      intentId: FIRST_INTENT_ID,
      family: "case_law",
      generation: "case_law_v5",
      entityId: DECISION_ID,
      indexId: INDEX_ID,
    },
  ]);
  expect(
    await db
      .select({ status: corpusIndexProjectionIntents.status })
      .from(corpusIndexProjectionIntents),
  ).toEqual([{ status: "cleanup_pending" }]);
});

test("retry classification defers poison work, then blocks the exhausted desired state", async () => {
  const startedAt = new Date("2026-08-25T12:00:00.000Z");
  await db.insert(caseLawDecisions).values({
    id: ERASE_DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "2 A 2/2026",
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
    desiredFingerprint: SECOND_FINGERPRINT,
    desiredIndexId: INDEX_ID,
    updatedAt: INITIAL_RUNNABLE_AT,
  });
  const leases = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 1,
        leaseMs: 60_000,
        testNow: startedAt,
        newIntentId: () => FIRST_INTENT_ID,
        newLeaseToken: () => FIRST_LEASE_TOKEN,
      }),
  );
  const lease = leases.at(0) ?? panic("Expected projection lease");
  expect(
    await db.transaction(
      async (tx) =>
        await classifyCorpusProjectionReservationFailureTx(
          asTestRaw<Transaction>(tx),
          {
            intentId: lease.intentId,
            leaseToken: lease.leaseToken,
            failure: {
              status: "retry_scheduled",
              kind: "payload_unavailable",
              retryDelayMs: 60_000,
              maxAttempts: 2,
              message: "canonical payload is temporarily unavailable",
            },
            testNow: startedAt,
          },
        ),
    ),
  ).toBe("retry_scheduled");

  const state = await db
    .select({
      workStatus: corpusIndexProjectionStates.workStatus,
      retryNotBefore: corpusIndexProjectionStates.retryNotBefore,
      failureAttempts: corpusIndexProjectionStates.failureAttempts,
    })
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID));
  expect(state.at(0)).toEqual({
    workStatus: "retry_scheduled",
    retryNotBefore: new Date("2026-08-25T12:01:00.000Z"),
    failureAttempts: 1,
  });
  const laterWork = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 1,
        leaseMs: 60_000,
        testNow: new Date("2026-08-25T12:00:59.999Z"),
        newIntentId: () => SECOND_INTENT_ID,
        newLeaseToken: () => SECOND_LEASE_TOKEN,
      }),
  );
  expect(laterWork.map(({ entityId }) => entityId)).toEqual([
    ERASE_DECISION_ID,
  ]);
  const retried = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 1,
        leaseMs: 60_000,
        testNow: new Date("2026-08-25T12:01:00.000Z"),
        newIntentId: () => ERASE_INTENT_ID,
        newLeaseToken: () => ERASE_LEASE_TOKEN,
      }),
  );
  expect(retried.map(({ entityId }) => entityId)).toEqual([DECISION_ID]);
  const retriedLease =
    retried.at(0) ?? panic("Expected retry projection lease");
  expect(
    await db.transaction(
      async (tx) =>
        await classifyCorpusProjectionReservationFailureTx(
          asTestRaw<Transaction>(tx),
          {
            intentId: retriedLease.intentId,
            leaseToken: retriedLease.leaseToken,
            failure: {
              status: "retry_scheduled",
              kind: "payload_unavailable",
              retryDelayMs: 60_000,
              maxAttempts: 2,
              message: "canonical payload remains unavailable",
            },
            testNow: new Date("2026-08-25T12:01:00.000Z"),
          },
        ),
    ),
  ).toBe("blocked");
  expect(
    await db
      .select({
        workStatus: corpusIndexProjectionStates.workStatus,
        retryNotBefore: corpusIndexProjectionStates.retryNotBefore,
        failureAttempts: corpusIndexProjectionStates.failureAttempts,
      })
      .from(corpusIndexProjectionStates)
      .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID)),
  ).toEqual([
    { workStatus: "blocked", retryNotBefore: null, failureAttempts: 2 },
  ]);
});

test("failure classification locks projection state before its intent", async () => {
  const classifiedAt = new Date("2026-08-25T12:00:00.000Z");
  const leases = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 1,
        leaseMs: 60_000,
        testNow: classifiedAt,
        newIntentId: () => FIRST_INTENT_ID,
        newLeaseToken: () => FIRST_LEASE_TOKEN,
      }),
  );
  const lease = leases.at(0) ?? panic("Expected projection lease");
  const statements: string[] = [];
  const loggedDb = drizzle({
    client,
    logger: {
      logQuery(query) {
        statements.push(query);
      },
    },
  });
  expect(
    await loggedDb.transaction(
      async (tx) =>
        await classifyCorpusProjectionReservationFailureTx(
          asTestRaw<Transaction>(tx),
          {
            intentId: lease.intentId,
            leaseToken: lease.leaseToken,
            failure: {
              status: "blocked",
              kind: "revision_too_large",
              message: "payload exceeds the structural ceiling",
            },
            testNow: classifiedAt,
          },
        ),
    ),
  ).toBe("blocked");
  const stateLock = statements.findIndex(
    (query) =>
      query.includes('from "corpus_index_projection_states"') &&
      query.includes("for update"),
  );
  const intentLock = statements.findIndex(
    (query) =>
      query.includes('from "corpus_index_projection_intents"') &&
      query.includes("for update"),
  );
  expect(stateLock).toBeGreaterThanOrEqual(0);
  expect(intentLock).toBeGreaterThan(stateLock);
});

test("unknown append cleanup starts its barrier at append start", async () => {
  const appendStartedAt = new Date("2026-08-25T12:00:00.000Z");
  const failureObservedAt = new Date("2026-08-25T12:00:10.000Z");
  const leases = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 1,
        leaseMs: 5 * 60_000,
        testNow: appendStartedAt,
        newIntentId: () => FIRST_INTENT_ID,
        newLeaseToken: () => FIRST_LEASE_TOKEN,
      }),
  );
  const lease = leases.at(0) ?? panic("Expected projection lease");
  expect(
    await db.transaction(
      async (tx) =>
        await startCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: lease.intentId,
          leaseToken: lease.leaseToken,
          testNow: appendStartedAt,
        }),
    ),
  ).toBe("started");
  expect(
    await db.transaction(
      async (tx) =>
        await abandonCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: lease.intentId,
          leaseToken: lease.leaseToken,
          testNow: failureObservedAt,
          errorMessage: "append response was lost",
        }),
    ),
  ).toBe("cleanup_pending");

  const intents = await db
    .select({
      appendStartedAt: corpusIndexProjectionIntents.appendStartedAt,
      appendPublishBarrierAt:
        corpusIndexProjectionIntents.appendPublishBarrierAt,
      cleanupNotBefore: corpusIndexProjectionIntents.cleanupNotBefore,
    })
    .from(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, lease.intentId));
  const expectedBarrier = corpusIndexUnknownAppendBarrierAt(
    appendStartedAt,
    CORPUS_INDEX_MANIFESTS.case_law_v5,
  );
  expect(intents).toEqual([
    {
      appendStartedAt,
      appendPublishBarrierAt: expectedBarrier,
      cleanupNotBefore: expectedBarrier,
    },
  ]);
});

test("applied census rejects an incomplete multi-document revision", async () => {
  const appliedAt = new Date("2026-08-25T12:00:00.000Z");
  const leases = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 1,
        leaseMs: 5 * 60_000,
        testNow: appliedAt,
        newIntentId: () => FIRST_INTENT_ID,
        newLeaseToken: () => FIRST_LEASE_TOKEN,
      }),
  );
  const lease = leases.at(0) ?? panic("Expected projection lease");
  expect(
    await db.transaction(
      async (tx) =>
        await startCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: lease.intentId,
          leaseToken: lease.leaseToken,
          testNow: appliedAt,
        }),
    ),
  ).toBe("started");
  expect(
    await db.transaction(
      async (tx) =>
        await commitCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: lease.intentId,
          leaseToken: lease.leaseToken,
          documentCount: 1,
          testNow: appliedAt,
        }),
    ),
  ).toMatchObject({ status: "applied" });

  const runInTransaction = async <TResult>(
    operation: (tx: Transaction) => Promise<TResult>,
  ): Promise<TResult> =>
    await db.transaction(
      async (tx) => await operation(asTestRaw<Transaction>(tx)),
    );
  expect(
    await censusAppliedCorpusProjections({
      runInTransaction,
      client: {
        aggregate: async () =>
          Result.ok({
            projection_revisions: {
              buckets: [{ key: FIRST_INTENT_ID, doc_count: 2 }],
              doc_count_error_upper_bound: 0,
              sum_other_doc_count: 0,
            },
          }),
      },
      family: "case_law",
      generation: "case_law_v5",
      indexId: INDEX_ID,
      after: null,
      limit: 1,
    }),
  ).toEqual(
    Result.ok({
      expected: "present",
      inspected: 1,
      driftRevisions: [FIRST_INTENT_ID],
      nextCursor: DECISION_ID,
      complete: false,
    }),
  );
  await db
    .update(corpusIndexProjectionStates)
    .set({
      workStatus: "blocked",
      failureAttempts: 2,
      lastFailureKind: "payload_unavailable",
      lastFailureMessage: "fixture failure",
    })
    .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID));
  expect(
    await db.transaction(
      async (tx) =>
        await repairAppliedCorpusProjectionDriftTx(asTestRaw<Transaction>(tx), {
          family: "case_law",
          generation: "case_law_v5",
          indexId: INDEX_ID,
          revisions: [FIRST_INTENT_ID],
          testNow: appliedAt,
        }),
    ),
  ).toBe(1);
  const repairedState = await db
    .select({
      appliedRevision: corpusIndexProjectionStates.appliedRevision,
      failureAttempts: corpusIndexProjectionStates.failureAttempts,
      lastFailureKind: corpusIndexProjectionStates.lastFailureKind,
      lastFailureMessage: corpusIndexProjectionStates.lastFailureMessage,
      retryNotBefore: corpusIndexProjectionStates.retryNotBefore,
      workStatus: corpusIndexProjectionStates.workStatus,
    })
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID));
  const repairedIntent = await db
    .select({ status: corpusIndexProjectionIntents.status })
    .from(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, FIRST_INTENT_ID));
  expect(repairedState).toEqual([
    {
      appliedRevision: FIRST_INTENT_ID,
      failureAttempts: 0,
      lastFailureKind: null,
      lastFailureMessage: null,
      retryNotBefore: null,
      workStatus: "repair_scheduled",
    },
  ]);
  expect(repairedIntent).toEqual([{ status: "cleanup_pending" }]);
  expect(
    await db.transaction(
      async (tx) =>
        await repairAppliedCorpusProjectionDriftTx(asTestRaw<Transaction>(tx), {
          family: "case_law",
          generation: "case_law_v5",
          indexId: INDEX_ID,
          revisions: [FIRST_INTENT_ID],
          testNow: appliedAt,
        }),
    ),
  ).toBe(0);
});

test("one append request receives one post-lock database timestamp", async () => {
  await db.insert(caseLawDecisions).values({
    id: ERASE_DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "2 A 2/2026",
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
    desiredFingerprint: SECOND_FINGERPRINT,
    desiredIndexId: INDEX_ID,
    updatedAt: INITIAL_RUNNABLE_AT,
  });
  const intentIds = [FIRST_INTENT_ID, SECOND_INTENT_ID] as const;
  const leaseTokens = [FIRST_LEASE_TOKEN, SECOND_LEASE_TOKEN] as const;
  let intentIndex = 0;
  let tokenIndex = 0;
  const reservedAt = new Date("2026-08-25T12:00:00.000Z");
  const leases = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 2,
        leaseMs: 60_000,
        testNow: reservedAt,
        newIntentId: () =>
          intentIds.at(intentIndex++) ?? panic("Lost test intent id"),
        newLeaseToken: () =>
          leaseTokens.at(tokenIndex++) ?? panic("Lost test lease token"),
      }),
  );
  const requestStartedAt = new Date("2026-08-25T12:00:10.000Z");
  expect(
    await db.transaction(
      async (tx) =>
        await startCorpusProjectionAppendBatchTx(asTestRaw<Transaction>(tx), {
          leases,
          testNow: requestStartedAt,
        }),
    ),
  ).toEqual(leases.map(({ intentId }) => ({ intentId, status: "started" })));
  expect(
    await db
      .select({ appendStartedAt: corpusIndexProjectionIntents.appendStartedAt })
      .from(corpusIndexProjectionIntents)
      .orderBy(corpusIndexProjectionIntents.id),
  ).toEqual([
    { appendStartedAt: requestStartedAt },
    { appendStartedAt: requestStartedAt },
  ]);
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
  // The census and the cleanup below both observe the index, and neither may
  // run inside the engine's commit window, so this append is accepted far
  // enough in the past to be published. The fence itself is proven in the
  // publish-fence test.
  const acceptedAt = new Date(
    Date.now() -
      corpusIndexAppendPublishDelayMs(CORPUS_INDEX_MANIFESTS.case_law_v5) -
      1000,
  );
  expect(
    await db.transaction(
      async (tx) =>
        await startCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: firstLease.intentId,
          leaseToken: firstLease.leaseToken,
          testNow: acceptedAt,
        }),
    ),
  ).toBe("started");
  expect(
    await db.transaction(
      async (tx) =>
        await commitCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
          intentId: firstLease.intentId,
          leaseToken: firstLease.leaseToken,
          documentCount: 1,
          testNow: acceptedAt,
        }),
    ),
  ).toMatchObject({ status: "applied", entityId: DECISION_ID });
  expect(
    await db.transaction(
      async (tx) =>
        await readAppliedCorpusProjectionCensusPageTx(
          asTestRaw<Transaction>(tx),
          {
            family: "case_law",
            generation: "case_law_v5",
            indexId: INDEX_ID,
            after: null,
            limit: 1,
          },
        ),
    ),
  ).toEqual({
    candidates: [
      {
        entityId: DECISION_ID,
        revision: FIRST_INTENT_ID,
        expectedDocumentCount: 1,
      },
    ],
    nextCursor: DECISION_ID,
    complete: false,
  });
  expect(
    await db.transaction(
      async (tx) =>
        await revalidateAppliedCorpusProjectionCensusTx(
          asTestRaw<Transaction>(tx),
          {
            family: "case_law",
            generation: "case_law_v5",
            indexId: INDEX_ID,
            revisions: [FIRST_INTENT_ID],
          },
        ),
    ),
  ).toEqual([
    {
      entityId: DECISION_ID,
      revision: FIRST_INTENT_ID,
      expectedDocumentCount: 1,
    },
  ]);

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
  expect(
    await db.transaction(
      async (tx) =>
        await revalidateAppliedCorpusProjectionCensusTx(
          asTestRaw<Transaction>(tx),
          {
            family: "case_law",
            generation: "case_law_v5",
            indexId: INDEX_ID,
            revisions: [FIRST_INTENT_ID],
          },
        ),
    ),
  ).toEqual([]);
  expect(
    await db.transaction(
      async (tx) =>
        await prepareCorpusProjectionReplacementsTx(
          asTestRaw<Transaction>(tx),
          {
            family: "case_law",
            generation: "case_law_v5",
            limit: 10,
          },
        ),
    ),
  ).toEqual([]);

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
    panic("Expected a releasable projection settlement lease");
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
        await readSettledCorpusProjectionCensusPageTx(
          asTestRaw<Transaction>(tx),
          {
            family: "case_law",
            generation: "case_law_v5",
            indexId: INDEX_ID,
            after: null,
            limit: 2,
          },
        ),
    ),
  ).toEqual({
    candidates: [{ revision: FIRST_INTENT_ID }],
    nextCursor: FIRST_INTENT_ID,
    complete: true,
  });

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
  expect(
    await db.transaction(
      async (tx) =>
        await reopenCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
          intentIds: [firstLease.intentId],
          indexId: INDEX_ID,
          errorMessage: "duplicate orphan census observation",
        }),
    ),
  ).toBe(0);
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

test("cleanup-owned replacement work rotates behind a bounded queue window", async () => {
  await db.insert(caseLawDecisions).values({
    id: ERASE_READY_DECISION_ID,
    sourceId: SOURCE_ID,
    caseNumber: "1 A 5/2026",
    court: "Test court",
    country: "CZE",
    language: "cs",
    contentHash: "1".repeat(64),
    projectionEpoch: 1n,
  });
  await db.insert(corpusIndexProjectionStates).values({
    family: "case_law",
    generation: "case_law_v5",
    entityId: ERASE_READY_DECISION_ID,
    desiredAction: "upsert",
    desiredEpoch: 1n,
    desiredFingerprint: FIRST_FINGERPRINT,
    desiredIndexId: INDEX_ID,
  });
  const intentIds = [FIRST_INTENT_ID, SECOND_INTENT_ID][Symbol.iterator]();
  const leaseTokens = [FIRST_LEASE_TOKEN, SECOND_LEASE_TOKEN][
    Symbol.iterator
  ]();
  const leases = await db.transaction(
    async (tx) =>
      await reserveCorpusProjectionIntentsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 2,
        leaseMs: 60_000,
        testNow: new Date(),
        newIntentId: () =>
          intentIds.next().value ?? panic("Expected replacement intent id"),
        newLeaseToken: () =>
          leaseTokens.next().value ?? panic("Expected replacement lease token"),
      }),
  );
  expect(leases).toHaveLength(2);
  const blockedLease =
    leases.find(({ entityId }) => entityId === DECISION_ID) ??
    panic("Expected blocked replacement lease");
  const readyLease =
    leases.find(({ entityId }) => entityId === ERASE_READY_DECISION_ID) ??
    panic("Expected ready replacement lease");
  const applyLeases = async (index: number): Promise<void> => {
    const lease = leases.at(index);
    if (lease === undefined) {
      return;
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
    expect(
      await db.transaction(
        async (tx) =>
          await commitCorpusProjectionAppendTx(asTestRaw<Transaction>(tx), {
            intentId: lease.intentId,
            leaseToken: lease.leaseToken,
            documentCount: 1,
          }),
      ),
    ).toMatchObject({ status: "applied" });
    await applyLeases(index + 1);
  };
  await applyLeases(0);

  const blockedAt = new Date(Date.now() - 2 * 60_000);
  const readyAt = new Date(Date.now() - 60_000);
  const rotatedAt = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(caseLawDecisions)
      .set({ projectionEpoch: 2n })
      .where(eq(caseLawDecisions.id, DECISION_ID));
    await tx
      .update(caseLawDecisions)
      .set({ projectionEpoch: 2n })
      .where(eq(caseLawDecisions.id, ERASE_READY_DECISION_ID));
    await tx
      .update(corpusIndexProjectionStates)
      .set({
        desiredEpoch: 2n,
        desiredFingerprint: SECOND_FINGERPRINT,
        updatedAt: blockedAt,
      })
      .where(eq(corpusIndexProjectionStates.entityId, DECISION_ID));
    await tx
      .update(corpusIndexProjectionStates)
      .set({
        desiredEpoch: 2n,
        desiredFingerprint: SECOND_FINGERPRINT,
        updatedAt: readyAt,
      })
      .where(eq(corpusIndexProjectionStates.entityId, ERASE_READY_DECISION_ID));
  });

  const first = await db.transaction(
    async (tx) =>
      await prepareCorpusProjectionReplacementsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 1,
        testNow: rotatedAt,
      }),
  );
  expect(first.map(({ intentId }) => intentId)).toEqual([
    blockedLease.intentId,
  ]);
  const second = await db.transaction(
    async (tx) =>
      await prepareCorpusProjectionReplacementsTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 1,
        testNow: rotatedAt,
      }),
  );
  expect(second.map(({ intentId }) => intentId)).toEqual([readyLease.intentId]);
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
          documentCount: 1,
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
  // Cleanup deletes by query, so it starts only once the engine has
  // certainly published what it is deleting.
  const publishedAt = new Date(
    databaseNow.getTime() +
      corpusIndexAppendPublishDelayMs(CORPUS_INDEX_MANIFESTS.case_law_v5),
  );
  const cleanupNow = new Date(publishedAt.getTime() + 1000);
  await setDatabaseClock(cleanupNow);
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
    panic("Expected first settlement lease");
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
    panic("Expected settlement lease");
  }
  const verified = await CorpusProjectionCleanupSettlementProof.verify({
    client: settledProjectionClient,
    lease: settlement,
  });
  if (verified.isErr()) {
    panic("Expected successful settlement verification");
  }
  if (verified.value.status !== "verified") {
    panic("Expected verified settlement proof");
  }
  const proof = verified.value.proof;
  expect(
    await withDatabaseClock(
      async (tx) =>
        await settleCorpusProjectionCleanupTx(tx, {
          proof,
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

  const recoveryNow = new Date(cleanupNow.getTime() + 2 * 60_000);
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
      appendPublishBarrierAt: publishedAt,
      cleanupNotBefore: cleanupNow,
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
          testNow: appendStartedAt,
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
          documentCount: 1,
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
    updatedAt: INITIAL_RUNNABLE_AT,
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
  expect(
    await withDatabaseClock(
      async (tx) =>
        await advanceCorpusProjectionErasuresTx(tx, {
          family: "case_law",
          generation: "case_law_v5",
          limit: 10,
        }),
    ),
  ).toMatchObject({
    claimedCount: 1,
    cancelledRevisions: [],
    scheduledRevisions: [],
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

  await db.transaction(async (tx) => {
    await tx
      .update(caseLawDecisions)
      .set({ projectionEpoch: 3n })
      .where(eq(caseLawDecisions.id, ERASE_DECISION_ID));
    await tx
      .update(corpusIndexProjectionStates)
      .set({
        desiredAction: "upsert",
        desiredEpoch: 3n,
        desiredFingerprint: SECOND_FINGERPRINT,
        desiredIndexId: INDEX_ID,
      })
      .where(eq(corpusIndexProjectionStates.entityId, ERASE_DECISION_ID));
  });

  expect(
    await db.transaction(
      async (tx) =>
        await reopenCorpusProjectionCleanupTx(asTestRaw<Transaction>(tx), {
          intentIds: [lease.intentId],
          indexId: INDEX_ID,
          errorMessage: "orphan census rediscovered an erased revision",
        }),
    ),
  ).toBe(1);
  const reopenedState = await db
    .select({
      action: corpusIndexProjectionStates.appliedAction,
      epoch: corpusIndexProjectionStates.appliedEpoch,
      appliedAt: corpusIndexProjectionStates.appliedAt,
    })
    .from(corpusIndexProjectionStates)
    .where(eq(corpusIndexProjectionStates.entityId, ERASE_DECISION_ID));
  expect(reopenedState).toEqual([
    { action: null, epoch: null, appliedAt: null },
  ]);
});

test("cleanup-owned erasure work rotates behind a bounded queue window", async () => {
  const blockedAt = new Date(Date.now() - 2 * 60_000);
  const readyAt = new Date(Date.now() - 60_000);
  const rotatedAt = new Date();
  await db.insert(caseLawDecisions).values([
    {
      id: ERASE_DECISION_ID,
      sourceId: SOURCE_ID,
      caseNumber: "1 A 3/2026",
      court: "Test court",
      country: "CZE",
      language: "cs",
      contentHash: "e".repeat(64),
      projectionEpoch: 1n,
    },
    {
      id: ERASE_READY_DECISION_ID,
      sourceId: SOURCE_ID,
      caseNumber: "1 A 4/2026",
      court: "Test court",
      country: "CZE",
      language: "cs",
      contentHash: "f".repeat(64),
      projectionEpoch: 1n,
    },
  ]);
  await db.insert(corpusIndexProjectionStates).values([
    {
      family: "case_law",
      generation: "case_law_v5",
      entityId: ERASE_DECISION_ID,
      desiredAction: "erase",
      desiredEpoch: 1n,
      updatedAt: blockedAt,
    },
    {
      family: "case_law",
      generation: "case_law_v5",
      entityId: ERASE_READY_DECISION_ID,
      desiredAction: "erase",
      desiredEpoch: 1n,
      updatedAt: readyAt,
    },
  ]);
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
      entityId: ERASE_READY_DECISION_ID,
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
        testNow: rotatedAt,
      }),
  );
  expect(result).toMatchObject({
    claimedCount: 1,
    cancelledRevisions: [],
    scheduledRevisions: [],
    appliedEntityIds: [],
  });
  const nextResult = await db.transaction(
    async (tx) =>
      await advanceCorpusProjectionErasuresTx(asTestRaw<Transaction>(tx), {
        family: "case_law",
        generation: "case_law_v5",
        limit: 1,
        testNow: rotatedAt,
      }),
  );
  expect(nextResult).toMatchObject({
    claimedCount: 1,
    cancelledRevisions: [ERASE_INTENT_ID],
    scheduledRevisions: [],
    appliedEntityIds: [ERASE_READY_DECISION_ID],
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
