import { SQL } from "bun";
import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { databaseRelations } from "@/api/db/database-relations";
import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { registerCorpusIndexGenerationTx } from "@/api/lib/legal-search/corpus-index-generation-store";
import { reserveCorpusProjectionIntentsTx } from "@/api/lib/legal-search/corpus-index-projection-store";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("corpus projection reservation (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(true).toBe(true);
    });
  });
} else {
  describe("corpus projection reservation (postgres)", () => {
    test("stale concurrent snapshots elect one append attempt", async () => {
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
      const target = {
        family: "case_law",
        generation: "case_law_v5",
      } as const;
      const sourceId = toSafeId<"caseLawSource">(Bun.randomUUIDv7());
      const entityId = toSafeId<"caseLawDecision">(Bun.randomUUIDv7());
      const firstIntentId = toSafeId<"corpusIndexProjectionIntent">(
        Bun.randomUUIDv7(),
      );
      const secondIntentId = toSafeId<"corpusIndexProjectionIntent">(
        Bun.randomUUIDv7(),
      );
      const secondSnapshotReady = Promise.withResolvers<undefined>();
      const releaseSecondSnapshot = Promise.withResolvers<undefined>();

      try {
        await firstDb.insert(caseLawSources).values({
          id: sourceId,
          adapterKey: `projection-reservation-${suffix}`,
          name: "Projection reservation",
        });
        await firstDb.insert(caseLawDecisions).values({
          id: entityId,
          sourceId,
          caseNumber: `projection-reservation-${suffix}`,
          court: "Projection reservation court",
          country: "CZE",
          language: "cs",
          contentHash: "a".repeat(64),
          projectionEpoch: 1n,
        });
        await firstDb.transaction(
          async (tx) => await registerCorpusIndexGenerationTx(tx, target),
        );
        await firstDb.insert(corpusIndexProjectionStates).values({
          ...target,
          entityId,
          desiredAction: "upsert",
          desiredEpoch: 1n,
          desiredFingerprint: "b".repeat(64),
          desiredIndexId: "case_law_v5_cs_sk",
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
        });

        const secondReservation = secondDb.transaction(async (tx) => {
          await tx.execute(
            sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`,
          );
          await tx
            .select({ generation: corpusIndexGenerations.generation })
            .from(corpusIndexGenerations)
            .where(
              and(
                eq(corpusIndexGenerations.family, target.family),
                eq(corpusIndexGenerations.generation, target.generation),
              ),
            );
          secondSnapshotReady.resolve(undefined);
          await releaseSecondSnapshot.promise;
          return await reserveCorpusProjectionIntentsTx(tx, {
            ...target,
            limit: 1,
            leaseMs: 60_000,
            newIntentId: () => secondIntentId,
            newLeaseToken: () => Bun.randomUUIDv7(),
          });
        });
        await secondSnapshotReady.promise;

        const firstReservation = await firstDb.transaction(
          async (tx) =>
            await reserveCorpusProjectionIntentsTx(tx, {
              ...target,
              limit: 1,
              leaseMs: 60_000,
              newIntentId: () => firstIntentId,
              newLeaseToken: () => Bun.randomUUIDv7(),
            }),
        );
        releaseSecondSnapshot.resolve(undefined);

        expect(firstReservation.map(({ intentId }) => intentId)).toEqual([
          firstIntentId,
        ]);
        expect(await secondReservation).toEqual([]);
        expect(
          await firstDb.$count(
            corpusIndexProjectionIntents,
            and(
              eq(corpusIndexProjectionIntents.family, target.family),
              eq(corpusIndexProjectionIntents.generation, target.generation),
              eq(corpusIndexProjectionIntents.entityId, entityId),
            ),
          ),
        ).toBe(1);
      } finally {
        releaseSecondSnapshot.resolve(undefined);
        await firstDb
          .update(corpusIndexGenerations)
          .set({ status: "retired" })
          .where(
            and(
              eq(corpusIndexGenerations.family, target.family),
              eq(corpusIndexGenerations.generation, target.generation),
            ),
          );
        await firstDb
          .delete(corpusIndexProjectionIntents)
          .where(
            and(
              eq(corpusIndexProjectionIntents.family, target.family),
              eq(corpusIndexProjectionIntents.generation, target.generation),
              eq(corpusIndexProjectionIntents.entityId, entityId),
            ),
          );
        await firstDb
          .delete(corpusIndexProjectionStates)
          .where(
            and(
              eq(corpusIndexProjectionStates.family, target.family),
              eq(corpusIndexProjectionStates.generation, target.generation),
              eq(corpusIndexProjectionStates.entityId, entityId),
            ),
          );
        await firstDb
          .delete(caseLawDecisions)
          .where(eq(caseLawDecisions.id, entityId));
        await firstDb
          .delete(caseLawSources)
          .where(eq(caseLawSources.id, sourceId));
        await firstDb
          .delete(corpusIndexGenerations)
          .where(
            and(
              eq(corpusIndexGenerations.family, target.family),
              eq(corpusIndexGenerations.generation, target.generation),
            ),
          );
        await Promise.all([firstClient.close(), secondClient.close()]);
      }
    });
  });
}
