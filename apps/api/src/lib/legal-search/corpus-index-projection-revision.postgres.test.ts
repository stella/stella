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

import { lockCorpusIndexProjectionMutationsTx } from "./corpus-index-projection-revision";

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
    test("opposite target orders serialize without deadlocking", async () => {
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
        expect(acquiredWhileFirstHeld).toBe(false);

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

      try {
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
          status: "serving",
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
        expect(await writer).toBeUndefined();
        expect(await activation).toEqual({ epoch: 1n, created: true });
        expect(
          await writerDb.transaction(
            async (tx) =>
              await reconcileCorpusProjectionDesiredStateTx(tx, subject),
          ),
        ).toEqual({ epoch: 1n, changed: false, generationCount: 1 });
      } finally {
        releaseWriter.resolve(undefined);
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
              inArray(corpusIndexGenerations.generation, [
                legacyGeneration,
                "case_law_v5",
              ]),
            ),
          );
        await Promise.all([writerClient.close(), activationClient.close()]);
      }
    });
  });
}
