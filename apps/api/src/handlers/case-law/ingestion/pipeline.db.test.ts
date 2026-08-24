import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import {
  ADAPTER_KEYS,
  PARSER_VERSIONS,
} from "@/api/handlers/case-law/consts";
import type { DocumentAst } from "@/api/handlers/case-law/document-ast";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline";
import type { SafeId } from "@/api/lib/branded-types";
import { getPgErrorCode } from "@/api/lib/pg-error";

type JsonbStorageRow = {
  storageType: string;
  version: string | null;
  // Only selected by the refresh test.
  indexedHash?: string | null;
};

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const documentAst = {
  version: 1,
  source: {
    system: ADAPTER_KEYS.CZ_NS,
    documentId: "jsonb-regression",
    webUrl: "https://example.test/web",
    printUrl: "https://example.test/print",
  },
  metadata: {
    caseNumber: "28 Cdo 5171/2008",
    court: "Nejvyšší soud",
    ecli: "ECLI:CZ:NS:2009:28.CDO.5171.2008.1",
    decisionDate: "2009-08-26",
    decisionType: "rozsudek",
    keywords: [],
    statutes: [],
  },
  blocks: [
    {
      id: "b1",
      anchorId: "p1",
      type: "paragraph",
      role: "holding",
      inlines: [{ type: "text", text: "Adapter output must stay JSONB." }],
      plainText: "Adapter output must stay JSONB.",
    },
  ],
} satisfies DocumentAst;

const ingestionResult = {
  caseNumber: "28 Cdo 5171/2008",
  ecli: "ECLI:CZ:NS:2009:28.CDO.5171.2008.1",
  court: "Nejvyšší soud",
  country: "CZE",
  language: "cs",
  decisionDate: "2009-08-26",
  decisionType: "rozsudek",
  fulltext: "Adapter output must stay JSONB.",
  sourceUrl: "https://example.test/web",
  documentUrl: "https://example.test/print",
  metadata: { source: "regression" },
  rawHash: "jsonb-regression-hash",
  documentAst,
  parserVersion: PARSER_VERSIONS[ADAPTER_KEYS.CZ_NS],
} satisfies IngestionResult;

if (!databaseUrl || !runPostgresTests) {
  describe.skip("case-law ingestion JSONB persistence", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("case-law ingestion JSONB persistence", () => {
    const adapterKey = `jsonb-regression-cz-ns-${Bun.randomUUIDv7()}`;
    const db = drizzle(databaseUrl, {
      relations: { ...relations, ...authRelationsPart },
    });
    const scopedDb: ScopedDb = async (callback) =>
      await db.transaction(async (tx) => await callback(tx));
    let sourceId: SafeId<"caseLawSource">;

    beforeAll(async () => {
      const [source] = await db
        .insert(caseLawSources)
        .values({
          adapterKey,
          name: "JSONB regression source",
          enabled: false,
        })
        .returning({ id: caseLawSources.id });

      if (!source) {
        throw new Error("expected source row");
      }

      sourceId = source.id;
    });

    afterAll(async () => {
      if (!sourceId) {
        return;
      }

      await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
    });

    test("stores adapter documentAst output as a jsonb object", async () => {
      await processDecision({
        input: ingestionResult,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      const [row] = await db.execute(sql<JsonbStorageRow>`
        SELECT
          jsonb_typeof(document_ast) AS "storageType",
          document_ast ->> 'version' AS "version"
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
          AND case_number = ${ingestionResult.caseNumber}
          AND language = ${ingestionResult.language}
      `);

      expect(row).toBeDefined();
      expect(row?.["storageType"]).toBe("object");
      expect(row?.["version"]).toBe("1");
    });

    test("keeps adapter documentAst as an object when refreshing a decision", async () => {
      await processDecision({
        input: ingestionResult,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });
      await db.execute(sql`
        UPDATE case_law_decisions
        SET indexed_hash = 'stale-indexed-hash'
        WHERE source_id = ${sourceId}
          AND case_number = ${ingestionResult.caseNumber}
          AND language = ${ingestionResult.language}
      `);
      await processDecision({
        input: {
          ...ingestionResult,
          rawHash: "jsonb-regression-hash-refresh",
          metadata: { source: "regression-refresh" },
        },
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      const [row] = await db.execute(sql<JsonbStorageRow>`
        SELECT
          jsonb_typeof(document_ast) AS "storageType",
          document_ast ->> 'version' AS "version",
          indexed_hash AS "indexedHash"
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
          AND case_number = ${ingestionResult.caseNumber}
          AND language = ${ingestionResult.language}
      `);

      expect(row).toBeDefined();
      expect(row?.["storageType"]).toBe("object");
      expect(row?.["version"]).toBe("1");
      // A refresh must clear indexedHash so the corpus indexer re-picks
      // the row even when only metadata changed.
      expect(row?.["indexedHash"]).toBeNull();
    });

    test("database-fences legacy refreshes after observation ordering activates", async () => {
      const caseNumber = `legacy-fence-${Bun.randomUUIDv7()}`;
      const initial = {
        ...ingestionResult,
        caseNumber,
        rawHash: "legacy-fence-current",
      };
      await processDecision({
        input: initial,
        observationOrder: 10n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T13:00:00.000Z"),
      });

      const legacyFailure: unknown = await db
        .execute(sql`
          UPDATE ${caseLawDecisions}
          SET source_hash = 'legacy-fence-stale'
          WHERE source_id = ${sourceId}
            AND case_number = ${caseNumber}
        `)
        .then(
          () => null,
          (error: unknown) => error,
        );
      // Drizzle wraps the driver error, and Bun's SQL driver reports the
      // SQLSTATE on `errno` rather than `code`; read it through the helper
      // that already knows both shapes.
      expect(getPgErrorCode(legacyFailure)).toBe("55000");

      await processDecision({
        input: { ...initial, rawHash: "legacy-fence-newer" },
        observationOrder: 11n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T13:00:01.000Z"),
      });
      const ordered = (
        await db
          .select({
            order: caseLawDecisions.sourceObservationOrder,
            sourceHash: caseLawDecisions.sourceHash,
          })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.caseNumber, caseNumber))
          .limit(1)
      ).at(0);
      expect(ordered).toEqual({
        order: 11n,
        sourceHash: "legacy-fence-newer",
      });

      const compensationOrder = (
        await db
          .update(caseLawSources)
          .set({
            observationOrder: sql`greatest(${caseLawSources.observationOrder}, 11) + 1`,
          })
          .where(eq(caseLawSources.id, sourceId))
          .returning({ order: caseLawSources.observationOrder })
      ).at(0)?.order;
      if (compensationOrder === undefined) {
        throw new Error("expected compensation order");
      }
      await db
        .update(caseLawDecisions)
        .set({
          sourceHash: "legacy-fence-current",
          sourceObservationHash: "legacy-fence-newer",
          sourceObservationOrder: compensationOrder,
        })
        .where(eq(caseLawDecisions.caseNumber, caseNumber));
      const compensated = (
        await db
          .select({
            order: caseLawDecisions.sourceObservationOrder,
            sourceHash: caseLawDecisions.sourceHash,
          })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.caseNumber, caseNumber))
          .limit(1)
      ).at(0);
      expect(compensated).toEqual({
        order: compensationOrder,
        sourceHash: "legacy-fence-current",
      });

      const replayCaseNumber = `compensation-cas-${Bun.randomUUIDv7()}`;
      const replayInput = {
        ...ingestionResult,
        caseNumber: replayCaseNumber,
        rawHash: "compensation-cas-current",
      };
      await processDecision({
        input: replayInput,
        observationOrder: 20n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T13:01:00.000Z"),
      });
      await processDecision({
        input: replayInput,
        observationOrder: 21n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T13:01:01.000Z"),
      });
      const staleCompensationOrder = (
        await db
          .update(caseLawSources)
          .set({
            observationOrder: sql`greatest(${caseLawSources.observationOrder}, 21) + 1`,
          })
          .where(eq(caseLawSources.id, sourceId))
          .returning({ order: caseLawSources.observationOrder })
      ).at(0)?.order;
      if (staleCompensationOrder === undefined) {
        throw new Error("expected stale compensation order");
      }
      const staleCompensation = await db
        .update(caseLawDecisions)
        .set({
          sourceHash: "compensation-cas-previous",
          sourceObservationHash: replayInput.rawHash,
          sourceObservationOrder: staleCompensationOrder,
        })
        .where(
          and(
            eq(caseLawDecisions.caseNumber, replayCaseNumber),
            eq(caseLawDecisions.sourceHash, replayInput.rawHash),
            eq(caseLawDecisions.sourceObservationOrder, 20n),
          ),
        )
        .returning({ id: caseLawDecisions.id });
      expect(staleCompensation).toHaveLength(0);
      const replayWinner = (
        await db
          .select({
            order: caseLawDecisions.sourceObservationOrder,
            sourceHash: caseLawDecisions.sourceHash,
          })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.caseNumber, replayCaseNumber))
          .limit(1)
      ).at(0);
      expect(replayWinner).toEqual({
        order: 21n,
        sourceHash: replayInput.rawHash,
      });

      await db
        .update(caseLawDecisions)
        .set({ sourceObservationOrder: null })
        .where(eq(caseLawDecisions.caseNumber, caseNumber));
      await db.execute(sql`
        UPDATE ${caseLawDecisions}
        SET source_hash = 'legacy-transition-allowed'
        WHERE source_id = ${sourceId}
          AND case_number = ${caseNumber}
      `);
      const transition = (
        await db
          .select({ sourceHash: caseLawDecisions.sourceHash })
          .from(caseLawDecisions)
          .where(eq(caseLawDecisions.caseNumber, caseNumber))
          .limit(1)
      ).at(0);
      expect(transition?.sourceHash).toBe("legacy-transition-allowed");
    });

    test("legacy cursor fencing preserves the prior checkpoint token", async () => {
      const heldCursor = "legacy-checkpoint-held";
      const heldAt = new Date("2026-07-31T13:02:00.000Z");
      await db
        .update(caseLawSources)
        .set({
          syncCursor: heldCursor,
          lastSyncAt: heldAt,
          observationOrder: sql`greatest(${caseLawSources.observationOrder}, 100)`,
          checkpointObservationOrder: 100n,
        })
        .where(eq(caseLawSources.id, sourceId));

      await db
        .update(caseLawSources)
        .set({
          syncCursor: heldCursor,
          lastSyncAt: new Date("2026-07-31T13:02:00.500Z"),
          checkpointObservationOrder: 98n,
        })
        .where(eq(caseLawSources.id, sourceId));

      await db
        .update(caseLawSources)
        .set({
          syncCursor: "legacy-checkpoint-advanced",
          lastSyncAt: new Date("2026-07-31T13:02:01.000Z"),
          checkpointObservationOrder: 99n,
        })
        .where(eq(caseLawSources.id, sourceId));

      const fenced = (
        await db
          .select({
            checkpointObservationOrder:
              caseLawSources.checkpointObservationOrder,
            lastSyncAt: caseLawSources.lastSyncAt,
            syncCursor: caseLawSources.syncCursor,
          })
          .from(caseLawSources)
          .where(eq(caseLawSources.id, sourceId))
          .limit(1)
      ).at(0);
      expect(fenced).toEqual({
        checkpointObservationOrder: 100n,
        lastSyncAt: heldAt,
        syncCursor: heldCursor,
      });
    });
  });
}
