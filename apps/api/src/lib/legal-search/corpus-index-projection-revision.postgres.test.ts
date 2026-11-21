import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { registerCorpusIndexGenerationTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  ensureCorpusProjectionDesiredStateTx,
  lockActiveCorpusProjectionSourceTx,
  reconcileCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { getPgErrorCode } from "@/api/lib/pg-error";
import {
  type GatedTestDb,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";

import {
  lockCorpusIndexProjectionFlipTx,
  lockCorpusIndexProjectionMutationsTx,
  lockCorpusIndexProjectionPromotionTx,
  lockCorpusIndexProjectionRevisionTx,
  readCorpusIndexProjectionRevisionTx,
} from "./corpus-index-projection-revision";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

type ExecutingTransaction = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

/** Start a wait measured by the database's own clock. */
const markWaitStart = async (tx: ExecutingTransaction): Promise<void> => {
  await tx.execute(
    sql`SELECT set_config('stella_test.wait_started', clock_timestamp()::text, true)`,
  );
};

/** Whether the database's clock says the wait since the mark lay in [min, max). */
const waitedWithin = async (
  tx: ExecutingTransaction,
  { min, max }: { min: string; max: string },
): Promise<unknown> => {
  const elapsed = sql`clock_timestamp() - current_setting('stella_test.wait_started')::timestamptz`;
  return executedRows(
    await tx.execute(
      sql`SELECT ${elapsed} >= ${min}::interval AS at_least, ${elapsed} < ${max}::interval AS below`,
    ),
  ).at(0);
};
/**
 * Hang guard for an exclusive take: far above the bound, so a take that waits
 * unbounded fails on the statement timeout (57014) instead of answering busy.
 */
const EXCLUSIVE_HANG_GUARD = "8s";

/**
 * A projection writer holding the shared side of the fence in an open
 * transaction until released. Every exclusive request queues behind it.
 */
const holdWriterFence = async (db: GatedTestDb) => {
  const holding = Promise.withResolvers<undefined>();
  const release = Promise.withResolvers<undefined>();
  const done = db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '60s'`);
    await tx.execute(
      sql`SELECT public.lock_corpus_projection_mutations_shared()`,
    );
    holding.resolve(undefined);
    await release.promise;
  });
  await holding.promise;
  return {
    release: async () => {
      release.resolve(undefined);
      await done;
    },
  };
};

const lockTimeoutOf = async (tx: ExecutingTransaction): Promise<unknown> =>
  executedRows(
    await tx.execute(
      sql`SELECT pg_catalog.current_setting('lock_timeout') AS lock_timeout`,
    ),
  ).at(0);

const UNREGISTERED_TARGET = {
  family: "case_law",
  generation: "case_law_v1",
} as const;

if (!databaseUrl || !runPostgresTests) {
  describe.skip("corpus projection mutation fence (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("corpus projection mutation fence (postgres)", () => {
    test("opposite target orders can mutate concurrently", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: firstDb } = openClient();
        const { db: secondDb } = openClient();
        const suffix = Date.now();
        const caseLawTarget = {
          family: "case_law",
          generation: `case_law_v${suffix}`,
        } as const;
        const legislationTarget = {
          family: "legislation",
          generation: `legislation_v${suffix}`,
        } as const;
        const targets = [caseLawTarget, legislationTarget] as const;
        const caseLawSourceId = toSafeId<"caseLawSource">(Bun.randomUUIDv7());
        const legislationSourceId = toSafeId<"legislationSource">(
          Bun.randomUUIDv7(),
        );
        const caseLawEntityIds = [
          toSafeId<"caseLawDecision">(Bun.randomUUIDv7()),
          toSafeId<"caseLawDecision">(Bun.randomUUIDv7()),
        ] as const;
        const legislationEntityIds = [
          toSafeId<"legislationDocument">(Bun.randomUUIDv7()),
          toSafeId<"legislationDocument">(Bun.randomUUIDv7()),
        ] as const;
        const generationPredicate = or(
          ...targets.map(({ family, generation }) =>
            and(
              eq(corpusIndexGenerations.family, family),
              eq(corpusIndexGenerations.generation, generation),
            ),
          ),
        );
        const statePredicate = or(
          ...targets.map(({ family, generation }) =>
            and(
              eq(corpusIndexProjectionStates.family, family),
              eq(corpusIndexProjectionStates.generation, generation),
            ),
          ),
        );
        const firstFenceAcquired = Promise.withResolvers<undefined>();
        const releaseFirstFence = Promise.withResolvers<undefined>();
        const secondFenceAttempted = Promise.withResolvers<undefined>();
        const secondFenceAcquired = Promise.withResolvers<undefined>();

        try {
          await firstDb.insert(caseLawSources).values({
            id: caseLawSourceId,
            adapterKey: `projection-fence-case-law-${suffix}`,
            name: "Projection fence case law",
          });
          await firstDb.insert(caseLawDecisions).values(
            caseLawEntityIds.map((id, index) => ({
              id,
              sourceId: caseLawSourceId,
              caseNumber: `projection-fence-${suffix}-${index}`,
              court: "Projection fence court",
              country: "CZE",
              language: "cs",
              projectionEpoch: 1n,
            })),
          );
          await firstDb.insert(legislationSources).values({
            id: legislationSourceId,
            adapterKey: `projection-fence-legislation-${suffix}`,
            name: "Projection fence legislation",
          });
          await firstDb.insert(legislationDocuments).values(
            legislationEntityIds.map((id, index) => ({
              id,
              sourceId: legislationSourceId,
              eli: `eli/test/projection-fence/${suffix}/${index}`,
              title: `Projection fence legislation ${index}`,
              country: "CZE",
              language: "cs",
              projectionEpoch: 1n,
            })),
          );
          await firstDb.insert(corpusIndexGenerations).values([
            {
              ...caseLawTarget,
              cluster: "q09",
              manifestDigest: "e".repeat(64),
              status: "building",
            },
            {
              ...legislationTarget,
              cluster: "q09",
              manifestDigest: "e".repeat(64),
              status: "building",
            },
          ]);

          const firstMutation = firstDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
            await lockCorpusIndexProjectionMutationsTx(tx, targets);
            firstFenceAcquired.resolve(undefined);
            await releaseFirstFence.promise;
            await tx.insert(corpusIndexProjectionStates).values({
              ...caseLawTarget,
              entityId: caseLawEntityIds[0],
              desiredAction: "erase",
              desiredEpoch: 1n,
            });
            await tx.insert(corpusIndexProjectionStates).values({
              ...legislationTarget,
              entityId: legislationEntityIds[0],
              desiredAction: "erase",
              desiredEpoch: 1n,
            });
          });
          await firstFenceAcquired.promise;

          const secondMutation = secondDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
            secondFenceAttempted.resolve(undefined);
            await lockCorpusIndexProjectionMutationsTx(tx, [
              legislationTarget,
              caseLawTarget,
            ]);
            secondFenceAcquired.resolve(undefined);
            await tx.insert(corpusIndexProjectionStates).values({
              ...legislationTarget,
              entityId: legislationEntityIds[1],
              desiredAction: "erase",
              desiredEpoch: 1n,
            });
            await tx.insert(corpusIndexProjectionStates).values({
              ...caseLawTarget,
              entityId: caseLawEntityIds[1],
              desiredAction: "erase",
              desiredEpoch: 1n,
            });
          });
          await secondFenceAttempted.promise;

          const acquiredWhileFirstHeld = await Promise.race([
            secondFenceAcquired.promise.then(() => true),
            Bun.sleep(100).then(() => false),
          ]);
          expect(acquiredWhileFirstHeld).toBe(true);

          releaseFirstFence.resolve(undefined);
          const results = await Promise.allSettled([
            firstMutation,
            secondMutation,
          ]);
          expect(results).toEqual([
            { status: "fulfilled", value: undefined },
            { status: "fulfilled", value: undefined },
          ]);
        } finally {
          releaseFirstFence.resolve(undefined);
          await firstDb
            .update(corpusIndexGenerations)
            .set({ status: "retired" })
            .where(generationPredicate);
          await firstDb
            .delete(corpusIndexProjectionStates)
            .where(statePredicate);
          await firstDb
            .delete(caseLawDecisions)
            .where(inArray(caseLawDecisions.id, caseLawEntityIds));
          await firstDb
            .delete(legislationDocuments)
            .where(inArray(legislationDocuments.id, legislationEntityIds));
          await firstDb
            .delete(caseLawSources)
            .where(eq(caseLawSources.id, caseLawSourceId));
          await firstDb
            .delete(legislationSources)
            .where(eq(legislationSources.id, legislationSourceId));
          await firstDb
            .delete(corpusIndexGenerations)
            .where(generationPredicate);
        }
      });
    });

    test("promotion waits for every in-flight mutation", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: writerDb } = openClient();
        const { db: promotionDb } = openClient();
        const target = {
          family: "case_law",
          generation: `case_law_v${Date.now()}`,
        } as const;
        const sourceId = toSafeId<"caseLawSource">(Bun.randomUUIDv7());
        const entityId = toSafeId<"caseLawDecision">(Bun.randomUUIDv7());
        const writerLocked = Promise.withResolvers<undefined>();
        const releaseWriter = Promise.withResolvers<undefined>();
        const promotionAttempted = Promise.withResolvers<undefined>();
        const promotionLocked = Promise.withResolvers<undefined>();

        try {
          await writerDb.insert(caseLawSources).values({
            id: sourceId,
            adapterKey: `projection-promotion-fence-${Date.now()}`,
            name: "Projection promotion fence",
          });
          await writerDb.insert(caseLawDecisions).values({
            id: entityId,
            sourceId,
            caseNumber: `projection-promotion-fence-${Date.now()}`,
            court: "Projection fence court",
            country: "CZE",
            language: "cs",
            projectionEpoch: 1n,
          });
          await writerDb.insert(corpusIndexGenerations).values({
            ...target,
            cluster: "q09",
            manifestDigest: "f".repeat(64),
            status: "building",
          });
          const writer = writerDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
            await tx.insert(corpusIndexProjectionStates).values({
              ...target,
              entityId,
              desiredAction: "erase",
              desiredEpoch: 1n,
            });
            writerLocked.resolve(undefined);
            await releaseWriter.promise;
          });
          await writerLocked.promise;

          const promotion = promotionDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
            // The order is under test, not the bound: wait past it.
            await tx.execute(sql`SET LOCAL lock_timeout = '4s'`);
            promotionAttempted.resolve(undefined);
            expect(
              (await lockCorpusIndexProjectionPromotionTx(tx, target)).isOk(),
            ).toBe(true);
            promotionLocked.resolve(undefined);
          });
          await promotionAttempted.promise;

          const overtookWriter = await Promise.race([
            promotionLocked.promise.then(() => true),
            Bun.sleep(100).then(() => false),
          ]);
          expect(overtookWriter).toBe(false);

          releaseWriter.resolve(undefined);
          await Promise.all([writer, promotion]);
        } finally {
          releaseWriter.resolve(undefined);
          await writerDb
            .update(corpusIndexGenerations)
            .set({ status: "retired" })
            .where(
              and(
                eq(corpusIndexGenerations.family, target.family),
                eq(corpusIndexGenerations.generation, target.generation),
              ),
            );
          await writerDb
            .delete(corpusIndexProjectionStates)
            .where(
              and(
                eq(corpusIndexProjectionStates.family, target.family),
                eq(corpusIndexProjectionStates.generation, target.generation),
              ),
            );
          await writerDb
            .delete(caseLawDecisions)
            .where(eq(caseLawDecisions.id, entityId));
          await writerDb
            .delete(caseLawSources)
            .where(eq(caseLawSources.id, sourceId));
          await writerDb
            .delete(corpusIndexGenerations)
            .where(
              and(
                eq(corpusIndexGenerations.family, target.family),
                eq(corpusIndexGenerations.generation, target.generation),
              ),
            );
        }
      });
    });

    test("a transaction with an older id cannot hide a post-proof mutation", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: olderDb } = openClient();
        const { db: newerDb } = openClient();
        const { db: proofDb } = openClient();
        const suffix = Date.now();
        const target = {
          family: "case_law",
          generation: `case_law_v${suffix}`,
        } as const;
        const sourceId = toSafeId<"caseLawSource">(Bun.randomUUIDv7());
        const entityIds = [
          toSafeId<"caseLawDecision">(Bun.randomUUIDv7()),
          toSafeId<"caseLawDecision">(Bun.randomUUIDv7()),
        ] as const;
        const allowOlderMutation = Promise.withResolvers<undefined>();
        const olderIdAssigned = Promise.withResolvers<number>();
        const olderMutationAttempted = Promise.withResolvers<undefined>();
        const olderMutationFinished = Promise.withResolvers<undefined>();
        const releaseProof = Promise.withResolvers<undefined>();
        const proofLocked = Promise.withResolvers<undefined>();
        const activeTransactions = new Set<Promise<unknown>>();

        try {
          await olderDb.insert(caseLawSources).values({
            id: sourceId,
            adapterKey: `projection-revision-order-${suffix}`,
            name: "Projection revision order",
          });
          await olderDb.insert(caseLawDecisions).values(
            entityIds.map((id, index) => ({
              id,
              sourceId,
              caseNumber: `projection-revision-order-${suffix}-${index}`,
              court: "Projection revision court",
              country: "CZE",
              language: "cs",
              projectionEpoch: 1n,
            })),
          );
          await olderDb.insert(corpusIndexGenerations).values({
            ...target,
            cluster: "q09",
            manifestDigest: "1".repeat(64),
            status: "building",
          });

          const olderMutation = olderDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
            const [row] = await tx.execute(
              sql<{ transactionId: string }>`
            SELECT pg_current_xact_id()::text AS "transactionId"
          `,
              "objects",
            );
            const transactionId = Number(row?.["transactionId"]);
            expect(Number.isSafeInteger(transactionId)).toBe(true);
            olderIdAssigned.resolve(transactionId);
            await allowOlderMutation.promise;
            olderMutationAttempted.resolve(undefined);
            await tx.insert(corpusIndexProjectionStates).values({
              ...target,
              entityId: entityIds[1],
              desiredAction: "erase",
              desiredEpoch: 1n,
            });
            olderMutationFinished.resolve(undefined);
          });
          activeTransactions.add(olderMutation);
          const olderTransactionId = await olderIdAssigned.promise;

          const newerTransactionId = await newerDb.transaction(async (tx) => {
            const [row] = await tx.execute(
              sql<{ transactionId: string }>`
            SELECT pg_current_xact_id()::text AS "transactionId"
          `,
              "objects",
            );
            await tx.insert(corpusIndexProjectionStates).values({
              ...target,
              entityId: entityIds[0],
              desiredAction: "erase",
              desiredEpoch: 1n,
            });
            return Number(row?.["transactionId"]);
          });
          expect(newerTransactionId).toBeGreaterThan(olderTransactionId);

          const proof = proofDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
            const proofRevision = (
              await lockCorpusIndexProjectionPromotionTx(tx, target)
            ).unwrap();
            proofLocked.resolve(undefined);
            await releaseProof.promise;
            return proofRevision;
          });
          activeTransactions.add(proof);
          await proofLocked.promise;
          allowOlderMutation.resolve(undefined);
          await olderMutationAttempted.promise;
          const mutationOvertookProof = await Promise.race([
            olderMutationFinished.promise.then(() => true),
            Bun.sleep(100).then(() => false),
          ]);
          expect(mutationOvertookProof).toBe(false);

          releaseProof.resolve(undefined);
          const [proofRevision] = await Promise.all([proof, olderMutation]);
          const finalRevision = await proofDb.transaction(
            async (tx) => await readCorpusIndexProjectionRevisionTx(tx, target),
          );
          expect(finalRevision).toBeGreaterThan(proofRevision);
        } finally {
          allowOlderMutation.resolve(undefined);
          releaseProof.resolve(undefined);
          await Promise.allSettled(activeTransactions);
          await olderDb
            .update(corpusIndexGenerations)
            .set({ status: "retired" })
            .where(
              and(
                eq(corpusIndexGenerations.family, target.family),
                eq(corpusIndexGenerations.generation, target.generation),
              ),
            );
          await olderDb
            .delete(corpusIndexProjectionStates)
            .where(
              and(
                eq(corpusIndexProjectionStates.family, target.family),
                eq(corpusIndexProjectionStates.generation, target.generation),
              ),
            );
          await olderDb
            .delete(caseLawDecisions)
            .where(inArray(caseLawDecisions.id, entityIds));
          await olderDb
            .delete(caseLawSources)
            .where(eq(caseLawSources.id, sourceId));
          await olderDb
            .delete(corpusIndexGenerations)
            .where(
              and(
                eq(corpusIndexGenerations.family, target.family),
                eq(corpusIndexGenerations.generation, target.generation),
              ),
            );
        }
      });
    });

    test("generation activation cannot overtake a canonical mutation", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: writerDb } = openClient();
        const { db: activationDb } = openClient();
        const suffix = Date.now();
        const sourceId = toSafeId<"caseLawSource">(Bun.randomUUIDv7());
        const decisionId = toSafeId<"caseLawDecision">(Bun.randomUUIDv7());
        const target = {
          family: "case_law",
          generation: "case_law_v5",
        } as const;
        const subject = { family: "case_law", entityId: decisionId } as const;
        const releaseWriter = Promise.withResolvers<undefined>();
        const writerLocked = Promise.withResolvers<undefined>();
        const activationAttempted = Promise.withResolvers<undefined>();
        let targetGenerationCreated = false;

        try {
          const existingTarget = (
            await writerDb
              .select({ generation: corpusIndexGenerations.generation })
              .from(corpusIndexGenerations)
              .where(
                and(
                  eq(corpusIndexGenerations.family, target.family),
                  eq(corpusIndexGenerations.generation, target.generation),
                ),
              )
              .limit(1)
          ).at(0);
          expect(existingTarget).toBeUndefined();
          await writerDb.insert(caseLawSources).values({
            id: sourceId,
            adapterKey: `projection-activation-${suffix}`,
            name: "Projection activation",
          });
          await writerDb.insert(caseLawDecisions).values({
            id: decisionId,
            sourceId,
            caseNumber: `projection-activation-${suffix}`,
            court: "Court before activation",
            country: "CZE",
            language: "cs",
            contentHash: "a".repeat(64),
          });
          const writer = writerDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
            const lock = await lockActiveCorpusProjectionSourceTx(tx, subject);
            expect(lock).toBeNull();
            await tx
              .update(caseLawDecisions)
              .set({ court: "Court committed before activation" })
              .where(eq(caseLawDecisions.id, decisionId));
            writerLocked.resolve(undefined);
            await releaseWriter.promise;
          });
          await writerLocked.promise;

          const activation = activationDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
            activationAttempted.resolve(undefined);
            await registerCorpusIndexGenerationTx(tx, target);
            return await ensureCorpusProjectionDesiredStateTx(
              tx,
              subject,
              target.generation,
            );
          });
          await activationAttempted.promise;

          const activatedWhileWriterHeld = await Promise.race([
            activation.then(() => true),
            Bun.sleep(100).then(() => false),
          ]);
          expect(activatedWhileWriterHeld).toBe(false);

          releaseWriter.resolve(undefined);
          await writer;
          const activationResult = await activation;
          targetGenerationCreated = true;
          expect(activationResult).toEqual({ epoch: 1n, created: true });
          expect(
            (
              await writerDb.transaction(
                async (tx) =>
                  await reconcileCorpusProjectionDesiredStateTx(tx, subject),
              )
            ).unwrap(),
          ).toEqual({ epoch: 1n, changed: false, generationCount: 1 });
        } finally {
          releaseWriter.resolve(undefined);
          const createdGenerations = targetGenerationCreated
            ? [target.generation]
            : [];
          await writerDb
            .update(corpusIndexGenerations)
            .set({ status: "retired" })
            .where(
              and(
                eq(corpusIndexGenerations.family, "case_law"),
                inArray(corpusIndexGenerations.generation, createdGenerations),
              ),
            );
          await writerDb
            .delete(corpusIndexProjectionStates)
            .where(eq(corpusIndexProjectionStates.entityId, decisionId));
          await writerDb
            .delete(caseLawDecisions)
            .where(eq(caseLawDecisions.id, decisionId));
          await writerDb
            .delete(caseLawSources)
            .where(eq(caseLawSources.id, sourceId));
          await writerDb
            .delete(corpusIndexGenerations)
            .where(
              and(
                eq(corpusIndexGenerations.family, "case_law"),
                inArray(corpusIndexGenerations.generation, createdGenerations),
              ),
            );
        }
      });
    });

    // timeout: three exclusive takes each wait the database's two-second bound.
    test(
      "an exclusive take behind a writer is busy after the database's bound, and the caller's transaction and lock_timeout are as they were",
      async () => {
        await withGatedTestClients(databaseUrl, async ({ openClient }) => {
          const { db: writerDb } = openClient();
          const { db: proofDb } = openClient();
          const writer = await holdWriterFence(writerDb);
          try {
            const observed = await proofDb.transaction(async (tx) => {
              // The deployed default: no lock_timeout of the caller's own.
              await tx.execute(sql`SET LOCAL lock_timeout = 0`);
              await tx.execute(
                sql`SELECT set_config('statement_timeout', ${EXCLUSIVE_HANG_GUARD}, true)`,
              );
              await markWaitStart(tx);
              // Busy before any read: the target needs no registration.
              const revision = await lockCorpusIndexProjectionRevisionTx(
                tx,
                UNREGISTERED_TARGET,
              );
              // The database waited its two-second bound, not zero and not
              // without end.
              const revisionWait = await waitedWithin(tx, {
                min: "1800 milliseconds",
                max: "6 seconds",
              });
              const promotion = await lockCorpusIndexProjectionPromotionTx(
                tx,
                UNREGISTERED_TARGET,
              );
              const flip = await lockCorpusIndexProjectionFlipTx(tx);
              return {
                outcomes: [revision, promotion, flip].map((outcome) =>
                  outcome.isErr() ? outcome.error.reason : "held",
                ),
                revisionWait,
                // A statement after the refusal runs: the transaction is usable.
                after: await lockTimeoutOf(tx),
              };
            });
            expect(observed.outcomes).toEqual([
              "lock_unavailable",
              "lock_unavailable",
              "lock_unavailable",
            ]);
            expect(observed.revisionWait).toEqual({
              at_least: true,
              below: true,
            });
            expect(observed.after).toEqual({ lock_timeout: "0" });
          } finally {
            await writer.release();
          }
        });
      },
      { timeout: 30_000 },
    );

    test("a caller's own lock_timeout bounds the exclusive wait and stays in place, whether the take is refused or granted", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: writerDb } = openClient();
        const { db: proofDb } = openClient();
        const writer = await holdWriterFence(writerDb);
        const released = { value: false };
        try {
          const observed = await proofDb.transaction(async (tx) => {
            await tx.execute(sql`SET LOCAL lock_timeout = '300ms'`);
            await tx.execute(
              sql`SELECT set_config('statement_timeout', ${EXCLUSIVE_HANG_GUARD}, true)`,
            );
            await markWaitStart(tx);
            const refused = await lockCorpusIndexProjectionFlipTx(tx);
            // Refused on the caller's 300 ms, well before the database's 2 s.
            const refusedWait = await waitedWithin(tx, {
              min: "250 milliseconds",
              max: "1800 milliseconds",
            });
            const afterRefusal = await lockTimeoutOf(tx);
            await writer.release();
            released.value = true;
            await tx.execute(sql`SET LOCAL lock_timeout = 0`);
            const granted = await lockCorpusIndexProjectionFlipTx(tx);
            return {
              refused: refused.isErr() ? refused.error.reason : "held",
              refusedWait,
              afterRefusal,
              granted: granted.isErr() ? granted.error.reason : "held",
              afterGrant: await lockTimeoutOf(tx),
            };
          });
          expect(observed).toMatchObject({
            refused: "lock_unavailable",
            refusedWait: { at_least: true, below: true },
            afterRefusal: { lock_timeout: "300ms" },
            granted: "held",
            afterGrant: { lock_timeout: "0" },
          });
        } finally {
          if (!released.value) {
            await writer.release();
          }
        }
      });
    });

    test("a granted exclusive take survives its savepoint and holds writers back until the transaction ends", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: proofDb } = openClient();
        const { db: writerDb } = openClient();
        const fenceHeld = Promise.withResolvers<undefined>();
        const releaseFence = Promise.withResolvers<undefined>();
        const proof = proofDb.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT set_config('statement_timeout', ${EXCLUSIVE_HANG_GUARD}, true)`,
          );
          const fenced = await lockCorpusIndexProjectionFlipTx(tx);
          expect(fenced.isOk()).toBe(true);
          fenceHeld.resolve(undefined);
          await releaseFence.promise;
        });
        try {
          await fenceHeld.promise;
          const writerAttempt = await Result.tryPromise({
            try: async () =>
              await writerDb.transaction(async (tx) => {
                await tx.execute(sql`SET LOCAL lock_timeout = '300ms'`);
                await tx.execute(
                  sql`SELECT public.lock_corpus_projection_mutations_shared()`,
                );
              }),
            catch: (cause) => cause,
          });
          expect(
            writerAttempt.isErr() ? getPgErrorCode(writerAttempt.error) : "ok",
          ).toBe("55P03");
        } finally {
          releaseFence.resolve(undefined);
          await proof;
        }
      });
    });

    test("the raw exclusive function raises lock_not_available after the bound for a caller with no lock_timeout", async () => {
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const { db: writerDb } = openClient();
        const { db: proofDb } = openClient();
        const writer = await holdWriterFence(writerDb);
        try {
          // The statement an older caller sends, outside any savepoint.
          const raw = await Result.tryPromise({
            try: async () =>
              await proofDb.transaction(async (tx) => {
                await tx.execute(sql`SET LOCAL lock_timeout = 0`);
                await tx.execute(
                  sql`SELECT set_config('statement_timeout', ${EXCLUSIVE_HANG_GUARD}, true)`,
                );
                await tx.execute(
                  sql`SELECT public.lock_corpus_projection_mutations_exclusive()`,
                );
              }),
            catch: (cause) => cause,
          });
          expect(raw.isErr() ? getPgErrorCode(raw.error) : "granted").toBe(
            "55P03",
          );
        } finally {
          await writer.release();
        }
      });
    });
  });
}
