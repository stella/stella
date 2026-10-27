import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import {
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import { createIngestionDb, markRlsDatabase } from "@/api/db/scoped";
import { createSafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  advanceCorpusProjectionErasuresTx,
  corpusProjectionRemovalIsPendingTx,
} from "@/api/lib/legal-search/corpus-index-projection-erasure-store";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgres = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";
if (!databaseUrl || !runPostgres) {
  describe.skip("projection removal settlement", () => {
    test("requires a migrated Postgres test database", () => {
      expect(runPostgres && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("projection removal settlement", () => {
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const scopedDb = createIngestionDb(markRlsDatabase(db));
    const decisionId = createSafeId<"caseLawDecision">();
    const sourceId = createSafeId<"caseLawSource">();
    const intentId = createSafeId<"corpusIndexProjectionIntent">();
    const generation = "case_law_v5";
    cleanUp(async () => {
      await db
        .update(corpusIndexGenerations)
        .set({ status: "retired" })
        .where(
          and(
            eq(corpusIndexGenerations.family, "case_law"),
            eq(corpusIndexGenerations.generation, generation),
          ),
        );
      await db
        .delete(corpusIndexProjectionStates)
        .where(eq(corpusIndexProjectionStates.entityId, decisionId));
      await db
        .delete(corpusIndexProjectionIntents)
        .where(eq(corpusIndexProjectionIntents.entityId, decisionId));
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.id, decisionId));
      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      await db
        .delete(corpusIndexGenerations)
        .where(
          and(
            eq(corpusIndexGenerations.family, "case_law"),
            eq(corpusIndexGenerations.generation, generation),
          ),
        );
    });

    test("removal waits for a registered generation and its reserved append to settle", async () => {
      expect(
        await scopedDb(
          async (tx) =>
            await corpusProjectionRemovalIsPendingTx(tx, decisionId),
        ),
      ).toBe(false);
      await db.insert(caseLawSources).values({
        id: sourceId,
        adapterKey: `removal-settlement-${sourceId}`,
        name: "Removal settlement fixture",
        enabled: false,
      });
      await db.insert(caseLawDecisions).values({
        id: decisionId,
        sourceId,
        caseNumber: "1 A 1/2026",
        country: "CZE",
        language: "cs",
        court: "Test court",
        projectionEpoch: 1n,
        contentHash: "a".repeat(64),
      });
      await db.insert(corpusIndexGenerations).values({
        family: "case_law",
        generation,
        cluster: "q09",
        status: "building",
        manifestDigest: corpusIndexManifestDigest(
          CORPUS_INDEX_MANIFESTS.case_law_v5,
        ),
      });
      await db.insert(corpusIndexProjectionStates).values({
        family: "case_law",
        generation,
        entityId: decisionId,
        desiredAction: "upsert",
        desiredEpoch: 1n,
        desiredFingerprint: "a".repeat(64),
        desiredIndexId: "case_law_cze",
      });
      await db.insert(corpusIndexProjectionIntents).values({
        id: intentId,
        family: "case_law",
        generation,
        entityId: decisionId,
        epoch: 1n,
        fingerprint: "a".repeat(64),
        indexId: "case_law_cze",
        status: "reserved",
        leaseToken: Bun.randomUUIDv7(),
        leaseExpiresAt: new Date("2032-01-01T00:00:00Z"),
      });
      expect(
        await scopedDb(
          async (tx) =>
            await corpusProjectionRemovalIsPendingTx(tx, decisionId),
        ),
      ).toBe(true);
      await db
        .update(caseLawDecisions)
        .set({ contentHash: null, projectionEpoch: 2n })
        .where(eq(caseLawDecisions.id, decisionId));
      await db
        .update(corpusIndexProjectionStates)
        .set({
          desiredAction: "erase",
          desiredEpoch: 2n,
          desiredFingerprint: null,
          desiredIndexId: null,
        })
        .where(eq(corpusIndexProjectionStates.entityId, decisionId));
      const erased = await scopedDb(
        async (tx) =>
          await advanceCorpusProjectionErasuresTx(tx, {
            family: "case_law",
            generation,
            limit: 1,
          }),
      );
      expect(erased.cancelledRevisions).toEqual([intentId]);
      expect(erased.appliedEntityIds).toEqual([decisionId]);
      expect(
        await scopedDb(
          async (tx) =>
            await corpusProjectionRemovalIsPendingTx(tx, decisionId),
        ),
      ).toBe(false);
    });
  });
}
