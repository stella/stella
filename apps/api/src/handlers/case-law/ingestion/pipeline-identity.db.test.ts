import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisions,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { bareCitationKey } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline";
import type { SafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

/**
 * Courts number their dockets per court, so one source covering many courts
 * issues the same number repeatedly. These decisions are unrelated and must
 * both survive; identity comes from the publisher's id, not the number.
 */
const decisionAt = (
  court: string,
  sourceDocumentId: string | undefined,
): IngestionResult => ({
  caseNumber: "0T/42/2019",
  sourceDocumentId,
  court,
  country: "SVK",
  language: "sk",
  decisionDate: "2019-05-14",
  decisionType: "rozsudok",
  fulltext: `Rozsudok ${court}`,
  metadata: { court },
  rawHash: `hash-${court}`,
  documentAst: EMPTY_AST,
});

if (!databaseUrl || !runPostgresTests) {
  describe.skip("case-law decision identity", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("case-law decision identity", () => {
    const adapterKey = `identity-${Bun.randomUUIDv7()}`;
    const db = drizzle(databaseUrl, {
      relations: { ...relations, ...authRelationsPart },
    });
    const scopedDb: ScopedDb = async (callback) =>
      // oxlint-disable-next-line node/callback-return -- arrow body already returns the callback result
      await db.transaction(async (tx) => await callback(tx));
    let sourceId: SafeId<"caseLawSource">;

    const storedCourts = async (): Promise<string[]> => {
      const rows = await db.execute(sql<{ court: string }>`
        SELECT court FROM case_law_decisions
        WHERE source_id = ${sourceId}
        ORDER BY court
      `);
      const list = Array.isArray(rows) ? rows : [];
      return list.map((row) => (isRecord(row) ? String(row["court"]) : ""));
    };

    const storedSlugs = async (
      sourceDocumentIds: string[],
    ): Promise<string[]> => {
      const rows = await db.execute(sql<{ slug: string }>`
        SELECT slug
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
          AND source_document_id IN (${sql.join(
            sourceDocumentIds.map(
              (sourceDocumentId) => sql`${sourceDocumentId}`,
            ),
            sql`, `,
          )})
        ORDER BY source_document_id
      `);
      const list = Array.isArray(rows) ? rows : [];
      return list.map((row) => (isRecord(row) ? String(row["slug"]) : ""));
    };

    beforeAll(async () => {
      const [source] = await db
        .insert(caseLawSources)
        .values({ adapterKey, name: "Identity source", enabled: false })
        .returning({ id: caseLawSources.id });
      if (!source) {
        throw new Error("expected source row");
      }
      sourceId = source.id;
    });

    afterAll(async () => {
      if (sourceId) {
        await db.delete(caseLawSources).where(eq(caseLawSources.id, sourceId));
      }
    });

    test("keeps decisions that share a docket across courts", async () => {
      await processDecision({
        input: decisionAt("Okresný súd Prievidza", "g1"),
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });
      await processDecision({
        input: decisionAt("Okresný súd Trenčín", "g2"),
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      expect(await storedCourts()).toEqual([
        "Okresný súd Prievidza",
        "Okresný súd Trenčín",
      ]);
    });

    test("treats the same publisher id as the same decision on replay", async () => {
      const before = await storedCourts();
      await processDecision({
        input: decisionAt("Okresný súd Prievidza", "g1"),
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      expect(await storedCourts()).toEqual(before);
    });

    test("uses publisher identity when a replay also carries a sheet number", async () => {
      const publisherId = "publisher-id-with-sheet";
      const decision = {
        ...decisionAt("Krajský súd Brno", publisherId),
        sheetNumber: "42",
      };

      await processDecision({
        input: decision,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });
      await processDecision({
        input: decision,
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      const rows = await db.execute(sql<{ count: number; sheetNumber: string }>`
        SELECT count(*)::int AS count, min(sheet_number) AS "sheetNumber"
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
          AND source_document_id = ${publisherId}
      `);
      const row = Array.isArray(rows) ? rows.at(0) : undefined;
      expect(isRecord(row) ? Number(row["count"]) : 0).toBe(1);
      expect(isRecord(row) ? row["sheetNumber"] : undefined).toBe("42");
    });

    test("adopts only the matching legacy row when a sibling arrives first", async () => {
      const legacyUrl = "https://publisher.test/legacy-document";
      const legacy = {
        ...decisionAt("Legacy identity", undefined),
        sourceUrl: legacyUrl,
      };
      await processDecision({
        input: legacy,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      const [legacyBefore] = await db.execute(sql<{ id: string }>`
        SELECT id
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
          AND case_number = ${legacy.caseNumber}
          AND source_document_id IS NULL
      `);

      await processDecision({
        input: {
          ...legacy,
          sourceDocumentId: "second-document-under-the-docket",
          sourceUrl: "https://publisher.test/sibling-document",
          rawHash: "hash-second-document",
        },
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      const identified = {
        ...legacy,
        sourceDocumentId: "publisher-id-learned-later",
        legacySourceUrls: [legacyUrl],
        rawHash: "hash-with-publisher-id",
      };
      await processDecision({
        input: identified,
        observationOrder: 3n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:02.000Z"),
      });

      const rows = await db.execute(sql<{
        count: number;
        learnedId: string;
      }>`
        SELECT count(*)::int AS count,
               min(id::text) FILTER (
                 WHERE source_document_id = 'publisher-id-learned-later'
               ) AS "learnedId"
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
          AND case_number = ${legacy.caseNumber}
          AND court = ${legacy.court}
      `);
      const row = Array.isArray(rows) ? rows.at(0) : undefined;
      expect(isRecord(row) ? Number(row["count"]) : 0).toBe(2);
      expect(isRecord(row) ? row["learnedId"] : undefined).toBe(
        isRecord(legacyBefore) ? legacyBefore["id"] : undefined,
      );
    });

    test("binds a redacted legacy tombstone before inserting siblings", async () => {
      const legacyUrl = "https://publisher.test/redacted-legacy";
      const legacy = {
        ...decisionAt("Redacted legacy identity", undefined),
        sourceUrl: legacyUrl,
      };
      await processDecision({
        input: legacy,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });
      await db
        .update(caseLawDecisions)
        .set({ redactedAt: new Date("2026-07-31T12:00:01.000Z") })
        .where(
          and(
            eq(caseLawDecisions.sourceId, sourceId),
            eq(caseLawDecisions.caseNumber, legacy.caseNumber),
            eq(caseLawDecisions.court, legacy.court),
          ),
        );

      await processDecision({
        input: {
          ...legacy,
          sourceDocumentId: "redacted-publisher-id",
          legacySourceUrls: [legacyUrl],
        },
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:02.000Z"),
      });
      await processDecision({
        input: {
          ...legacy,
          sourceDocumentId: "redacted-docket-sibling",
          sourceUrl: "https://publisher.test/redacted-sibling",
          rawHash: "hash-redacted-sibling",
        },
        observationOrder: 3n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:03.000Z"),
      });

      const rows = await db.execute(sql<{
        count: number;
        redactedIdentity: string;
      }>`
        SELECT count(*)::int AS count,
               min(source_document_id) FILTER (
                 WHERE redacted_at IS NOT NULL
               ) AS "redactedIdentity"
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
          AND case_number = ${legacy.caseNumber}
          AND court = ${legacy.court}
      `);
      const row = Array.isArray(rows) ? rows.at(0) : undefined;
      expect(isRecord(row) ? Number(row["count"]) : 0).toBe(2);
      expect(isRecord(row) ? row["redactedIdentity"] : undefined).toBe(
        "redacted-publisher-id",
      );
    });

    test("does not adopt a legacy URL when its ECLI contradicts the decision", async () => {
      const legacyUrl = "https://publisher.test/ambiguous-legacy-url";
      const legacy = {
        ...decisionAt("Ambiguous legacy identity", undefined),
        ecli: "ECLI:TEST:LEGACY",
        sourceUrl: legacyUrl,
      };
      await processDecision({
        input: legacy,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      await processDecision({
        input: {
          ...legacy,
          sourceDocumentId: "contradictory-ecli-publisher-id",
          legacySourceUrls: [legacyUrl],
          ecli: "ECLI:TEST:INCOMING",
          rawHash: "hash-contradictory-ecli",
        },
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      const rows = await db.execute(sql<{
        count: number;
        legacyCount: number;
        identifiedCount: number;
      }>`
        SELECT count(*)::int AS count,
               count(*) FILTER (WHERE source_document_id IS NULL)::int AS "legacyCount",
               count(*) FILTER (
                 WHERE source_document_id = 'contradictory-ecli-publisher-id'
               )::int AS "identifiedCount"
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
          AND court = ${legacy.court}
      `);
      const row = Array.isArray(rows) ? rows.at(0) : undefined;
      expect(isRecord(row) ? Number(row["count"]) : 0).toBe(2);
      expect(isRecord(row) ? Number(row["legacyCount"]) : 0).toBe(1);
      expect(isRecord(row) ? Number(row["identifiedCount"]) : 0).toBe(1);
    });

    test("replaces a listing placeholder when detail recovers the docket", async () => {
      const publisherId = "recovered-docket-publisher-id";
      const placeholder = {
        ...decisionAt("Recovered docket identity", publisherId),
        caseNumber: "NALUS record 7301",
        rawHash: "hash-listing-placeholder",
      };
      await processDecision({
        input: placeholder,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      const recoveredCaseNumber = "III.ÚS 81/24";
      await processDecision({
        input: {
          ...placeholder,
          caseNumber: recoveredCaseNumber,
          rawHash: "hash-recovered-docket",
        },
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      await processDecision({
        input: {
          ...placeholder,
          caseNumber: "NALUS record 7301",
          caseNumberIsPlaceholder: true,
          metadata: {
            ...placeholder.metadata,
            listedOnly: true,
            listingDocketMissing: true,
          },
          rawHash: "hash-withdrawn-detail-placeholder",
        },
        observationOrder: 3n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:02.000Z"),
      });

      const [row] = await db.execute(
        sql<{ caseNumber: string; citationKey: string }>`
          SELECT case_number AS "caseNumber", citation_key AS "citationKey"
          FROM case_law_decisions
          WHERE source_id = ${sourceId}
            AND source_document_id = ${publisherId}
        `,
      );
      expect(isRecord(row) ? row["caseNumber"] : undefined).toBe(
        recoveredCaseNumber,
      );
      expect(isRecord(row) ? row["citationKey"] : undefined).toBe(
        bareCitationKey(recoveredCaseNumber),
      );
    });

    test("an older overlapping observation cannot overwrite a newer winner", async () => {
      const publisherId = "observed-order";
      const newer = decisionAt("Newest observation", publisherId);
      const older = decisionAt("Older observation", publisherId);

      await processDecision({
        input: newer,
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });
      await processDecision({
        input: older,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      const [row] = await db.execute(sql<{ court: string }>`
        SELECT court FROM case_law_decisions
        WHERE source_id = ${sourceId} AND source_document_id = ${publisherId}
      `);
      expect(isRecord(row) ? row["court"] : undefined).toBe(
        "Newest observation",
      );
    });

    test("an identical replay advances the observation watermark", async () => {
      const publisherId = "observed-replay";
      const current = decisionAt("Current observation", publisherId);

      await processDecision({
        input: current,
        observationOrder: 20n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:02:00.000Z"),
      });
      const [initialRow] = await db.execute(sql<{ updatedAt: Date }>`
        SELECT updated_at AS "updatedAt" FROM case_law_decisions
        WHERE source_id = ${sourceId} AND source_document_id = ${publisherId}
      `);
      await processDecision({
        input: current,
        observationOrder: 22n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:02:02.000Z"),
      });
      await processDecision({
        input: decisionAt("Stale observation", publisherId),
        observationOrder: 21n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:02:01.000Z"),
      });

      const [row] = await db.execute(
        sql<{ court: string; observedAt: Date; updatedAt: Date }>`
        SELECT court,
               source_observed_at AS "observedAt",
               updated_at AS "updatedAt"
        FROM case_law_decisions
        WHERE source_id = ${sourceId} AND source_document_id = ${publisherId}
      `,
      );
      expect(isRecord(row) ? row["court"] : undefined).toBe(
        "Current observation",
      );
      expect(isRecord(row) ? row["observedAt"] : undefined).toEqual(
        new Date("2026-07-31T12:02:02.000Z"),
      );
      expect(isRecord(row) ? row["updatedAt"] : undefined).toEqual(
        isRecord(initialRow) ? initialRow["updatedAt"] : undefined,
      );
    });

    test("a watermark replay reconciles content changed after its read", async () => {
      const publisherId = "watermark-contention";
      const initial = decisionAt("Initial content", publisherId);
      const intervening = decisionAt("Intervening content", publisherId);

      await processDecision({
        input: initial,
        observationOrder: 30n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:03:00.000Z"),
      });

      let releaseReplay = (): void => undefined;
      const replayMayContinue = new Promise<void>((resolve) => {
        releaseReplay = resolve;
      });
      let replayReadCompleted = (): void => undefined;
      const replayHasRead = new Promise<void>((resolve) => {
        replayReadCompleted = resolve;
      });
      let replayCallCount = 0;
      const replayScopedDb: ScopedDb = async (transactionWork) => {
        const call = replayCallCount;
        replayCallCount += 1;
        const value = await scopedDb(transactionWork);
        if (call === 0) {
          replayReadCompleted();
          await replayMayContinue;
        }
        return value;
      };

      const replay = processDecision({
        input: initial,
        observationOrder: 32n,
        sourceId,
        scopedDb: replayScopedDb,
        observedAt: new Date("2026-07-31T12:03:02.000Z"),
      });
      await replayHasRead;
      await processDecision({
        input: intervening,
        observationOrder: 31n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:03:01.000Z"),
      });
      releaseReplay();
      await replay;

      const [row] = await db.execute(
        sql<{ court: string; sourceHash: string; observationOrder: bigint }>`
          SELECT court,
                 source_hash AS "sourceHash",
                 source_observation_order AS "observationOrder"
          FROM case_law_decisions
          WHERE source_id = ${sourceId}
            AND source_document_id = ${publisherId}
        `,
      );
      expect(row).toMatchObject({
        court: "Initial content",
        sourceHash: "hash-Initial content",
        observationOrder: 32n,
      });
    });

    test("a missed watermark compare-and-set holds a pending winner for replay", async () => {
      const publisherId = "watermark-pending-winner";
      const initial = decisionAt("Initial content", publisherId);

      await processDecision({
        input: initial,
        observationOrder: 40n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:04:00.000Z"),
      });

      let transactions = 0;
      const racingDb: ScopedDb = async (transactionWork) => {
        transactions += 1;
        if (transactions === 2) {
          await db
            .update(caseLawDecisions)
            .set({
              corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
              sourceObservationOrder: 42n,
            })
            .where(
              and(
                eq(caseLawDecisions.sourceId, sourceId),
                eq(caseLawDecisions.sourceDocumentId, publisherId),
              ),
            );
        }
        return await scopedDb(transactionWork);
      };

      const outcome = await processDecision({
        input: initial,
        observationOrder: 41n,
        sourceId,
        scopedDb: racingDb,
        observedAt: new Date("2026-07-31T12:04:01.000Z"),
      });

      expect(transactions).toBe(3);
      expect(outcome).toEqual({
        status: "retryable",
        inserted: false,
        reason: "corpus-write",
      });
    });

    test("database order wins independently of worker timestamps", async () => {
      const publisherId = "observed-tie";
      const authoritative = decisionAt("Database winner", publisherId);
      const clockAheadStale = decisionAt("Clock-ahead stale", publisherId);

      await processDecision({
        input: authoritative,
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:01:00.000Z"),
      });
      await processDecision({
        input: clockAheadStale,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:01:01.000Z"),
      });

      const [row] = await db.execute(sql<{ court: string }>`
        SELECT court FROM case_law_decisions
        WHERE source_id = ${sourceId} AND source_document_id = ${publisherId}
      `);
      expect(isRecord(row) ? row["court"] : undefined).toBe("Database winner");
    });

    test("concurrent collision inserts converge to unique stable slugs", async () => {
      const first = decisionAt("Okresný súd A", "concurrent-a");
      const second = decisionAt("Okresný súd B", "concurrent-b");

      await Promise.all([
        processDecision({
          input: first,
          observationOrder: 1n,
          sourceId,
          scopedDb,
          observedAt: new Date("2026-07-31T12:00:00.000Z"),
        }),
        processDecision({
          input: second,
          observationOrder: 1n,
          sourceId,
          scopedDb,
          observedAt: new Date("2026-07-31T12:00:00.000Z"),
        }),
      ]);

      const slugs = await storedSlugs(["concurrent-a", "concurrent-b"]);
      expect(slugs).toHaveLength(2);
      expect(new Set(slugs).size).toBe(2);

      const beforeReplay = [...slugs];
      await Promise.all([
        processDecision({
          input: first,
          observationOrder: 2n,
          sourceId,
          scopedDb,
          observedAt: new Date("2026-07-31T12:00:01.000Z"),
        }),
        processDecision({
          input: second,
          observationOrder: 2n,
          sourceId,
          scopedDb,
          observedAt: new Date("2026-07-31T12:00:01.000Z"),
        }),
      ]);
      expect(await storedSlugs(["concurrent-a", "concurrent-b"])).toEqual(
        beforeReplay,
      );
    });

    test("concurrent versions of one publisher id converge without dropping the loser", async () => {
      const publisherId = "concurrent-versions";
      const first = decisionAt("Okresný súd Initial", publisherId);
      const second = decisionAt("Okresný súd Reconciled", publisherId);

      let initialReadCount = 0;
      let releaseInitialReads = (): void => undefined;
      const bothInitialReads = new Promise<void>((resolve) => {
        releaseInitialReads = resolve;
      });
      const synchronizeInitialRead = async (): Promise<void> => {
        initialReadCount += 1;
        if (initialReadCount === 2) {
          releaseInitialReads();
        }
        await bothInitialReads;
      };

      let releaseFirstWrite = (): void => undefined;
      const firstWriteCompleted = new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      });

      let firstCallCount = 0;
      const firstScopedDb: ScopedDb = async (transactionWork) => {
        const call = firstCallCount;
        firstCallCount += 1;
        return await scopedDb(async (tx) => {
          if (call === 0) {
            const result = await transactionWork(tx);
            await synchronizeInitialRead();
            return result;
          }
          return await transactionWork(tx);
        });
      };

      let secondCallCount = 0;
      const secondScopedDb: ScopedDb = async (transactionWork) => {
        const call = secondCallCount;
        secondCallCount += 1;
        return await scopedDb(async (tx) => {
          if (call === 0) {
            const result = await transactionWork(tx);
            await synchronizeInitialRead();
            await firstWriteCompleted;
            return result;
          }
          return await transactionWork(tx);
        });
      };

      // Gate the second writer on the first writer finishing, not on a
      // transaction count. Slug allocation spends a transaction per
      // candidate and a taken candidate aborts it, so the write the second
      // writer has to observe is not at any fixed call index.
      const firstWrite = processDecision({
        input: first,
        observationOrder: 1n,
        sourceId,
        scopedDb: firstScopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });
      const firstWriteSettled = firstWrite.then(releaseFirstWrite, () => {
        // Release the second writer either way; `firstWrite` below reports
        // the failure, and leaving the latch closed would hang the suite.
        releaseFirstWrite();
      });

      await Promise.all([
        firstWrite,
        firstWriteSettled,
        processDecision({
          input: second,
          observationOrder: 2n,
          sourceId,
          scopedDb: secondScopedDb,
          observedAt: new Date("2026-07-31T12:00:01.000Z"),
        }),
      ]);

      const rows = await db.execute(
        sql<{ count: number; court: string; source_hash: string }>`
        SELECT count(*)::int AS count,
               min(court) AS court,
               min(source_hash) AS source_hash
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
          AND source_document_id = ${publisherId}
      `,
      );
      const row = Array.isArray(rows) ? rows.at(0) : undefined;
      expect(isRecord(row) ? Number(row["count"]) : 0).toBe(1);
      expect(isRecord(row) ? row["court"] : undefined).toBe(
        "Okresný súd Reconciled",
      );
      expect(isRecord(row) ? row["source_hash"] : undefined).toBe(
        "hash-Okresný súd Reconciled",
      );
    });
  });
}
