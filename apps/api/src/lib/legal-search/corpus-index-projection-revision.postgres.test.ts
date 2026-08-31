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
  });
}
