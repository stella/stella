import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { databaseRelations } from "@/api/db/database-relations";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { registerCorpusIndexGenerationTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  ensureCorpusProjectionDesiredStateTx,
  lockActiveCorpusProjectionSourceTx,
  reconcileCorpusProjectionDesiredStateTx,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";

import {
  lockCorpusIndexProjectionMutationsTx,
  lockCorpusIndexProjectionPromotionTx,
  readCorpusIndexProjectionRevisionTx,
} from "./corpus-index-projection-revision";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("corpus projection mutation fence (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("corpus projection mutation fence (postgres)", () => {
    test("opposite target orders can mutate concurrently", async () => {
      const firstClient = new SQL({ url: databaseUrl, max: 1 });
      const secondClient = new SQL({ url: databaseUrl, max: 1 });
      const firstDb = drizzle({
        client: firstClient,
        relations: databaseRelations,
      });
      const secondDb = drizzle({
        client: secondClient,
        relations: databaseRelations,
      });
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
        await firstDb.delete(corpusIndexProjectionStates).where(statePredicate);
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
        await firstDb.delete(corpusIndexGenerations).where(generationPredicate);
        await Promise.all([firstClient.close(), secondClient.close()]);
      }
    });

    test("promotion waits for every in-flight mutation", async () => {
      const writerClient = new SQL({ url: databaseUrl, max: 1 });
      const promotionClient = new SQL({ url: databaseUrl, max: 1 });
      const writerDb = drizzle({
        client: writerClient,
        relations: databaseRelations,
      });
      const promotionDb = drizzle({
        client: promotionClient,
        relations: databaseRelations,
      });
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
          promotionAttempted.resolve(undefined);
          await lockCorpusIndexProjectionPromotionTx(tx, target);
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
        await Promise.all([writerClient.close(), promotionClient.close()]);
      }
    });

    test("a transaction with an older id cannot hide a post-proof mutation", async () => {
      const olderClient = new SQL({ url: databaseUrl, max: 1 });
      const newerClient = new SQL({ url: databaseUrl, max: 1 });
      const proofClient = new SQL({ url: databaseUrl, max: 1 });
      const olderDb = drizzle({
        client: olderClient,
        relations: databaseRelations,
      });
      const newerDb = drizzle({
        client: newerClient,
        relations: databaseRelations,
      });
      const proofDb = drizzle({
        client: proofClient,
        relations: databaseRelations,
      });
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
          const [row] = await tx.execute(sql<{ transactionId: string }>`
            SELECT pg_current_xact_id()::text AS "transactionId"
          `);
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
          const [row] = await tx.execute(sql<{ transactionId: string }>`
            SELECT pg_current_xact_id()::text AS "transactionId"
          `);
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
          const proofRevision = await lockCorpusIndexProjectionPromotionTx(
            tx,
            target,
          );
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
        await Promise.all([
          olderClient.close(),
          newerClient.close(),
          proofClient.close(),
        ]);
      }
    });

    test("generation activation cannot overtake a canonical mutation", async () => {
      const writerClient = new SQL({ url: databaseUrl, max: 1 });
      const activationClient = new SQL({ url: databaseUrl, max: 1 });
      const writerDb = drizzle({
        client: writerClient,
        relations: databaseRelations,
      });
      const activationDb = drizzle({
        client: activationClient,
        relations: databaseRelations,
      });
      const suffix = Date.now();
      const sourceId = toSafeId<"caseLawSource">(Bun.randomUUIDv7());
      const decisionId = toSafeId<"caseLawDecision">(Bun.randomUUIDv7());
      const target = {
        family: "case_law",
        generation: "case_law_v5",
      } as const;
      const legacyGeneration = `case_law_v${suffix}`;
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
        await writerDb.insert(corpusIndexGenerations).values({
          family: "case_law",
          generation: legacyGeneration,
          cluster: "q08",
          manifestDigest: "a".repeat(64),
          status: "building",
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
          await writerDb.transaction(
            async (tx) =>
              await reconcileCorpusProjectionDesiredStateTx(tx, subject),
          ),
        ).toEqual({ epoch: 1n, changed: false, generationCount: 1 });
      } finally {
        releaseWriter.resolve(undefined);
        const createdGenerations = targetGenerationCreated
          ? [legacyGeneration, target.generation]
          : [legacyGeneration];
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
        await Promise.all([writerClient.close(), activationClient.close()]);
      }
    });
  });
}
