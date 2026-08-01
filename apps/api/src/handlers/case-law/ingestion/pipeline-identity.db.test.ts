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
        const value = await scopedDb(async (tx) => {
          if (call === 0) {
            const result = await transactionWork(tx);
            await synchronizeInitialRead();
            return result;
          }
          return await transactionWork(tx);
        });
        if (call === 1) {
          releaseFirstWrite();
        }
        return value;
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

      await Promise.all([
        processDecision({
          input: first,
          observationOrder: 1n,
          sourceId,
          scopedDb: firstScopedDb,
          observedAt: new Date("2026-07-31T12:00:00.000Z"),
        }),
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
