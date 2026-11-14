import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";

import { waitFor } from "@stll/test-kit";

import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { type SafeId, toSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import { proveCorpusProjectionRevisionsPresent } from "@/api/lib/legal-search/corpus-index-projection-engine";
import {
  type CorpusProjectionProofTiming,
  proveAcceptedCorpusProjectionAppendsTx,
  recordAcceptedCorpusProjectionAppendsTx,
} from "@/api/lib/legal-search/corpus-index-projection-store";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/** A manifest generation no other gated suite registers. */
const GENERATION = "case_law_v8";
const DOCUMENTS = 2;
const PROOF_CYCLE_TIMING = {
  type: "after_barrier",
} as const satisfies CorpusProjectionProofTiming;

type Fixture = {
  indexId: string;
  sourceId: string;
  entityId: string;
  intentId: SafeId<"corpusIndexProjectionIntent">;
};

/** One revision reserved, started and recorded as accepted by the engine. */
const seed = async (db: GatedTestDb): Promise<Fixture> => {
  const suffix = Bun.randomUUIDv7().replaceAll("-", "").slice(-12);
  const indexId = `case_law_v8_prove_${suffix}`;
  const sourceId = Bun.randomUUIDv7();
  const entityId = Bun.randomUUIDv7();
  const intentId = toSafeId<"corpusIndexProjectionIntent">(Bun.randomUUIDv7());
  const leaseToken = Bun.randomUUIDv7();
  const fingerprint = "f".repeat(64);
  // The suite owns the generation for its run and removes it afterwards.
  await db.insert(corpusIndexGenerations).values({
    family: "case_law",
    generation: GENERATION,
    cluster: "q09",
    manifestDigest: corpusIndexManifestDigest(
      CORPUS_INDEX_MANIFESTS.case_law_v8,
    ),
    status: "building",
  });
  await db.insert(caseLawSources).values({
    id: toSafeId<"caseLawSource">(sourceId),
    adapterKey: `projection-prove-${suffix}`,
    name: "Projection prove",
  });
  await db.insert(caseLawDecisions).values({
    id: toSafeId<"caseLawDecision">(entityId),
    sourceId: toSafeId<"caseLawSource">(sourceId),
    caseNumber: `projection-prove-${suffix}`,
    court: "Test court",
    country: "CZE",
    language: "cs",
    contentHash: "c".repeat(64),
    projectionEpoch: 1n,
  });
  await db.insert(corpusIndexProjectionStates).values({
    family: "case_law",
    generation: GENERATION,
    entityId,
    desiredAction: "upsert",
    desiredEpoch: 1n,
    desiredFingerprint: fingerprint,
    desiredIndexId: indexId,
  });
  await db.insert(corpusIndexProjectionIntents).values({
    id: intentId,
    family: "case_law",
    generation: GENERATION,
    entityId,
    epoch: 1n,
    fingerprint,
    indexId,
    status: "reserved",
    leaseToken,
    leaseExpiresAt: sql`clock_timestamp() + interval '5 minutes'`,
  });
  await db
    .update(corpusIndexProjectionIntents)
    .set({
      status: "append_started",
      appendStartedAt: sql`clock_timestamp()`,
      appendRequestRevisionCount: 1,
    })
    .where(eq(corpusIndexProjectionIntents.id, intentId));
  const recorded = await db.transaction(
    async (tx) =>
      await recordAcceptedCorpusProjectionAppendsTx(tx, {
        accepted: [{ intentId, leaseToken, documentCount: DOCUMENTS }],
      }),
  );
  expect(recorded).toEqual([{ status: "accepted", intentId }]);
  return { indexId, sourceId, entityId, intentId };
};

const exactCensus = async ({ indexId, intentId }: Fixture) => {
  const census = await proveCorpusProjectionRevisionsPresent({
    client: {
      aggregate: async () =>
        Result.ok({
          projection_revisions: {
            buckets: [{ key: intentId, doc_count: DOCUMENTS }],
            doc_count_error_upper_bound: 0,
            sum_other_doc_count: 0,
          },
        }),
    },
    indexId,
    expected: [{ revision: intentId, documentCount: DOCUMENTS }],
  });
  return census.isOk() ? census.value : panic("Expected an exact census");
};

const cleanUp = async (db: GatedTestDb, fixture: Fixture): Promise<void> => {
  const generation = and(
    eq(corpusIndexGenerations.family, "case_law"),
    eq(corpusIndexGenerations.generation, GENERATION),
  );
  // Projection history is deletable only under a retired generation.
  await db
    .update(corpusIndexGenerations)
    .set({ status: "retired" })
    .where(generation);
  await db
    .delete(corpusIndexProjectionIntents)
    .where(eq(corpusIndexProjectionIntents.id, fixture.intentId));
  await db
    .delete(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.generation, GENERATION),
        eq(corpusIndexProjectionStates.entityId, fixture.entityId),
      ),
    );
  await db
    .delete(caseLawDecisions)
    .where(
      eq(caseLawDecisions.id, toSafeId<"caseLawDecision">(fixture.entityId)),
    );
  await db
    .delete(caseLawSources)
    .where(eq(caseLawSources.id, toSafeId<"caseLawSource">(fixture.sourceId)));
  await db.delete(corpusIndexGenerations).where(generation);
};

if (!databaseUrl || !runPostgresTests) {
  describe.skip("corpus projection accept and prove (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("corpus projection accept and prove (postgres)", () => {
    test("two provers holding one census on two connections apply the revision once", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: firstDb } = openClient();
        const { db: secondDb } = openClient();
        const fixture = await seed(firstDb);
        try {
          const census = await exactCensus(fixture);
          const barrier =
            (
              await firstDb
                .select({
                  barrier: corpusIndexProjectionIntents.appendPublishBarrierAt,
                })
                .from(corpusIndexProjectionIntents)
                .where(eq(corpusIndexProjectionIntents.id, fixture.intentId))
            ).at(0)?.barrier ?? panic("Expected a stored barrier");
          const prove = async (db: GatedTestDb, hold?: () => Promise<void>) =>
            await db.transaction(async (tx) => {
              await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
              const outcome = await proveAcceptedCorpusProjectionAppendsTx(tx, {
                indexId: fixture.indexId,
                census,
                timing: PROOF_CYCLE_TIMING,
                testNow: barrier,
              });
              await hold?.();
              return outcome;
            });

          // The first prover holds the rows locked mid-transaction while the
          // second acts on the same census.
          const firstHolds = Promise.withResolvers<undefined>();
          const releaseFirst = Promise.withResolvers<undefined>();
          const first = prove(firstDb, async () => {
            firstHolds.resolve(undefined);
            await releaseFirst.promise;
          });
          await firstHolds.promise;
          const second = prove(secondDb);
          // The second prover waits on the first one's row locks.
          await waitFor(
            async () => {
              const waiting = await firstDb.execute<{ waiting: number }>(sql`
                SELECT count(*)::int AS waiting
                FROM pg_stat_activity
                WHERE datname = current_database()
                  AND wait_event_type = 'Lock'
              `);
              return (waiting.at(0)?.waiting ?? 0) > 0 ? true : undefined;
            },
            { description: "the second prover to wait on the row locks" },
          );
          releaseFirst.resolve(undefined);

          expect(await first).toEqual([
            {
              status: "applied",
              intentId: fixture.intentId,
              entityId: fixture.entityId,
            },
          ]);
          expect(await second).toEqual([
            { status: "already_applied", intentId: fixture.intentId },
          ]);
          expect(
            await firstDb
              .select({
                appliedRevision: corpusIndexProjectionStates.appliedRevision,
              })
              .from(corpusIndexProjectionStates)
              .where(
                and(
                  eq(corpusIndexProjectionStates.generation, GENERATION),
                  eq(corpusIndexProjectionStates.entityId, fixture.entityId),
                ),
              ),
          ).toEqual([{ appliedRevision: fixture.intentId }]);
        } finally {
          await cleanUp(firstDb, fixture);
        }
      });
    });
  });
}
