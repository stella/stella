import { panic, Result } from "better-result";
import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";
import { sha256Hex as hashContent } from "@stll/sha256/node";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_MIRROR_STATUS,
  caseLawDecisionSourceIdentities,
  caseLawDecisionAliases,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { createCaseLawDecisionSlugCandidate } from "@/api/handlers/case-law/decisions/slug";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { czUsAdapter } from "@/api/handlers/case-law/ingestion/adapters/cz-us";
import { bareCitationKey } from "@/api/handlers/case-law/ingestion/citation-extractor";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline/decision";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
  absentTextField,
  presentTextField,
} from "@/api/lib/case-law/decision-text";
import { plainTextIngestionResult } from "@/api/lib/legal-search/plain-text-assembly";
import { isRecord } from "@/api/lib/type-guards";
import {
  openGatedTestDatabase,
  withGatedTestClients,
} from "@/api/tests/gated-test-database";
import { asFetchMock } from "@/api/tests/helpers/test-tool-set";

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
): IngestionResult =>
  plainTextIngestionResult({
    caseNumber: "0T/42/2019",
    sourceDocumentId,
    court,
    country: "SVK",
    language: "sk",
    decisionDate: "2019-05-14",
    decisionType: "rozsudok",
    fulltext: `Rozsudok ${court}`,
    metadata: { court },
    textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
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
    const { db, cleanUp } = openGatedTestDatabase(databaseUrl);
    const scopedDb: ScopedDb = async (callback) =>
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

    cleanUp(async () => {
      if (sourceId) {
        await db
          .delete(caseLawDecisionAliases)
          .where(
            inArray(
              caseLawDecisionAliases.canonicalDecisionId,
              db
                .select({ id: caseLawDecisions.id })
                .from(caseLawDecisions)
                .where(eq(caseLawDecisions.sourceId, sourceId)),
            ),
          );
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

    test("publisher replay of a retired UUID resolves to the survivor without recreating a row", async () => {
      const retiredId = createSafeId<"caseLawDecision">();
      const survivorId = createSafeId<"caseLawDecision">();
      await db.insert(caseLawDecisions).values([
        {
          id: retiredId,
          sourceId,
          sourceDocumentId: "retired-publisher",
          country: "SVK",
          court: "Najvyšší súd SR",
          language: "sk",
          caseNumber: "1Cdo/1/2026",
        },
        {
          id: survivorId,
          sourceId,
          sourceDocumentId: "survivor-publisher",
          country: "SVK",
          court: "Najvyšší súd SR",
          language: "sk",
          caseNumber: "1Cdo/1/2026",
        },
      ]);
      await db.insert(caseLawDecisionSourceIdentities).values({
        sourceId,
        sourceDocumentId: "retired-publisher",
        decisionId: retiredId,
      });
      await db.insert(caseLawDecisionAliases).values({
        retiredDecisionId: retiredId,
        canonicalDecisionId: survivorId,
      });
      await db
        .delete(caseLawDecisions)
        .where(eq(caseLawDecisions.id, retiredId));
      const input = plainTextIngestionResult({
        ...decisionAt("Najvyšší súd SR", "retired-publisher"),
        caseNumber: "1Cdo/1/2026",
      });
      for (const observationOrder of [1n, 2n]) {
        await processDecision({
          input: {
            ...input,
            rawHash: `hash-alias-replay-${observationOrder}`,
          },
          observationOrder,
          sourceId,
          scopedDb,
          observedAt: new Date("2026-09-30T09:00:00Z"),
        });
      }
      const rows = await db
        .select({
          id: caseLawDecisions.id,
          sourceHash: caseLawDecisions.sourceHash,
        })
        .from(caseLawDecisions)
        .where(inArray(caseLawDecisions.id, [retiredId, survivorId]));
      expect(rows).toEqual([
        { id: survivorId, sourceHash: "hash-alias-replay-2" },
      ]);
      const claims = await db
        .select({ decisionId: caseLawDecisionSourceIdentities.decisionId })
        .from(caseLawDecisionSourceIdentities)
        .where(
          and(
            eq(caseLawDecisionSourceIdentities.sourceId, sourceId),
            eq(
              caseLawDecisionSourceIdentities.sourceDocumentId,
              "retired-publisher",
            ),
          ),
        );
      // The durable publisher receipt may retain the old UUID; replay resolves it.
      expect(claims).toEqual([{ decisionId: retiredId }]);
    });

    test("retirement serializes with a stale insert of the retired UUID", async () => {
      const retiredId = createSafeId<"caseLawDecision">();
      const survivorId = createSafeId<"caseLawDecision">();
      await db.insert(caseLawDecisions).values(
        [retiredId, survivorId].map((id) => ({
          id,
          sourceId,
          country: "SVK",
          court: "Concurrent retirement court",
          language: "sk",
          caseNumber: id,
        })),
      );
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const retirementClient = openClient({
          connection: { statement_timeout: 5000 },
        }).sql;
        const staleClient = openClient({
          connection: { statement_timeout: 5000 },
        }).sql;
        const [writer] = await staleClient`SELECT pg_backend_pid() AS pid`;
        const writerPid: unknown = writer?.pid;
        if (typeof writerPid !== "number") {
          throw new TypeError("Expected PostgreSQL backend PID");
        }
        const retirementReady = Promise.withResolvers<undefined>();
        const staleInsertStarted = Promise.withResolvers<undefined>();
        const lockObserved = Promise.withResolvers<undefined>();
        const releaseRetirement = Promise.withResolvers<undefined>();
        const retirement = retirementClient.begin(async (session) => {
          await session`INSERT INTO case_law_decision_aliases
            (retired_decision_id, canonical_decision_id)
            VALUES (${retiredId}::uuid, ${survivorId}::uuid)`;
          await session`DELETE FROM case_law_decisions WHERE id = ${retiredId}::uuid`;
          retirementReady.resolve(undefined);
          await staleInsertStarted.promise;
          // The alias is still uncommitted. The insert must wait on the
          // graph lock before checking it, rather than pass the guard and
          // wait on the deleted row's unique-index transaction lock.
          const deadline = Date.now() + 3000;
          let waitingLock: unknown;
          while (waitingLock === undefined && Date.now() < deadline) {
            const locks =
              await session`SELECT locktype, classid::int AS classid, objid::int AS objid
              FROM pg_locks WHERE pid = ${writerPid} AND NOT granted`;
            waitingLock = locks.at(0);
            if (waitingLock === undefined) {
              await Bun.sleep(10);
            }
          }
          expect(waitingLock).toMatchObject({
            locktype: "advisory",
            classid: 732_104,
            objid: 1,
          });
          lockObserved.resolve(undefined);
          await releaseRetirement.promise;
        });
        let staleInsert: Promise<unknown> | undefined;
        try {
          await Promise.race([retirementReady.promise, retirement]);
          staleInsert = staleClient.begin(async (session) => {
            staleInsertStarted.resolve(undefined);
            await session`INSERT INTO case_law_decisions
              (id, source_id, country, court, language, case_number)
              VALUES (${retiredId}::uuid, ${sourceId}::uuid, 'SVK',
                'Concurrent retirement court', 'sk', ${retiredId})`;
          });
          const staleOutcome = staleInsert.then(
            () => ({ status: "fulfilled" as const }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );
          await Promise.race([lockObserved.promise, retirement]);
          releaseRetirement.resolve(undefined);
          await retirement;
          expect(await staleOutcome).toMatchObject({
            status: "rejected",
            error: {
              message: expect.stringContaining("Decision UUID is retired"),
            },
          });
        } finally {
          staleInsertStarted.resolve(undefined);
          releaseRetirement.resolve(undefined);
          await Promise.allSettled([
            retirement,
            ...(staleInsert === undefined ? [] : [staleInsert]),
          ]);
        }
      });
      const decisions = await db
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(inArray(caseLawDecisions.id, [retiredId, survivorId]));
      expect(decisions).toEqual([{ id: survivorId }]);
      const aliases = await db
        .select({
          canonicalDecisionId: caseLawDecisionAliases.canonicalDecisionId,
        })
        .from(caseLawDecisionAliases)
        .where(eq(caseLawDecisionAliases.retiredDecisionId, retiredId));
      expect(aliases).toEqual([{ canonicalDecisionId: survivorId }]);
    }, 15_000);

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

    test("repoints an abandoned rollout reservation to the stored winner", async () => {
      const publisherId = "publisher-id-won-by-stale-task";
      const decision = decisionAt("Rolling deployment winner", publisherId);
      await processDecision({
        input: decision,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });
      const winner = await db.query.caseLawDecisions.findFirst({
        where: {
          sourceId: { eq: sourceId },
          sourceDocumentId: { eq: publisherId },
        },
        columns: { id: true },
      });
      if (winner === undefined) {
        throw new Error("expected rollout winner");
      }
      const abandonedId = createSafeId<"caseLawDecision">();
      await db
        .update(caseLawDecisionSourceIdentities)
        .set({ decisionId: abandonedId })
        .where(
          and(
            eq(caseLawDecisionSourceIdentities.sourceId, sourceId),
            eq(caseLawDecisionSourceIdentities.sourceDocumentId, publisherId),
          ),
        );

      await processDecision({
        input: decision,
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      const reservation =
        await db.query.caseLawDecisionSourceIdentities.findFirst({
          where: {
            sourceId: { eq: sourceId },
            sourceDocumentId: { eq: publisherId },
          },
          columns: { decisionId: true },
        });
      const rows = await db.execute(sql<{ count: number }>`
        SELECT count(*)::int AS count
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
          AND source_document_id = ${publisherId}
      `);
      const row = Array.isArray(rows) ? rows.at(0) : undefined;
      expect(reservation?.decisionId).toBe(winner.id);
      expect(isRecord(row) ? Number(row["count"]) : 0).toBe(1);
    });

    test("uses publisher identity when a replay also carries a sheet number", async () => {
      const publisherId = "publisher-id-with-sheet";
      const decision = plainTextIngestionResult({
        ...decisionAt("Krajský súd Brno", publisherId),
        sheetNumber: "42",
      });

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
      const legacy = plainTextIngestionResult({
        ...decisionAt("Legacy identity", undefined),
        sourceUrl: legacyUrl,
      });
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
      const legacy = plainTextIngestionResult({
        ...decisionAt("Redacted legacy identity", undefined),
        sourceUrl: legacyUrl,
      });
      await processDecision({
        input: legacy,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });
      await db
        .update(caseLawDecisions)
        .set({
          contentHash: null,
          documentAst: null,
          fulltext: null,
          redactedAt: new Date("2026-07-31T12:00:01.000Z"),
          sections: null,
        })
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
      const legacy = plainTextIngestionResult({
        ...decisionAt("Ambiguous legacy identity", undefined),
        ecli: "ECLI:TEST:LEGACY",
        sourceUrl: legacyUrl,
      });
      await processDecision({
        input: legacy,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      await processDecision({
        input: plainTextIngestionResult({
          ...legacy,
          sourceDocumentId: "contradictory-ecli-publisher-id",
          legacySourceUrls: [legacyUrl],
          ecli: "ECLI:TEST:INCOMING",
          rawHash: "hash-contradictory-ecli",
        }),
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

    /** The rows stored under one docket, identity-less rows last. */
    const docketRows = async (
      caseNumber: string,
    ): Promise<{ id: string; sourceDocumentId: string | null }[]> =>
      await db.query.caseLawDecisions.findMany({
        where: { sourceId: { eq: sourceId }, caseNumber },
        columns: { id: true, sourceDocumentId: true },
        orderBy: { sourceDocumentId: "asc" },
      });

    const storeLegacyRow = async (
      caseNumber: string,
      ecli: string,
    ): Promise<{ id: string; sourceDocumentId: string | null }> => {
      await processDecision({
        input: plainTextIngestionResult({
          ...decisionAt(`Legacy ECLI ${caseNumber}`, undefined),
          caseNumber,
          ecli,
        }),
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });
      const [legacyRow] = await docketRows(caseNumber);
      if (legacyRow === undefined) {
        throw new Error("expected legacy row");
      }
      return legacyRow;
    };

    test("adopts a legacy row whose ECLI differs only in spelling", async () => {
      const caseNumber = "Pl.ÚS 18/01";
      const legacyRow = await storeLegacyRow(
        caseNumber,
        "ECLI:CZ:US:2002:PL.US.18.01.1",
      );

      await processDecision({
        input: plainTextIngestionResult({
          ...decisionAt(`Legacy ECLI ${caseNumber}`, "nalus-record:plenary"),
          caseNumber,
          ecli: "ECLI:CZ:US:2002:Pl.US.18.01.1",
          rawHash: "hash-nalus-plenary",
        }),
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      expect(await docketRows(caseNumber)).toEqual([
        { id: legacyRow.id, sourceDocumentId: "nalus-record:plenary" },
      ]);
    });

    test("adopts a legacy row through the ECLI an earlier release built", async () => {
      const caseNumber = "II.ÚS 1030/25";
      const legacyRow = await storeLegacyRow(
        caseNumber,
        "ECLI:CZ:US:2025:2.US.1030.25.1",
      );

      await processDecision({
        input: plainTextIngestionResult({
          ...decisionAt(`Legacy ECLI ${caseNumber}`, "nalus-record:uncounted"),
          caseNumber,
          ecli: "ECLI:CZ:US:2025:2.US.1030.25",
          legacyEcli: "ECLI:CZ:US:2025:2.US.1030.25.1",
          rawHash: "hash-nalus-uncounted",
        }),
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      expect(await docketRows(caseNumber)).toEqual([
        { id: legacyRow.id, sourceDocumentId: "nalus-record:uncounted" },
      ]);
    });

    test("stores a keyed row under its docket without a trailing part marker", async () => {
      await processDecision({
        input: plainTextIngestionResult({
          ...decisionAt("Trailing marker", "trailing-marker-document"),
          caseNumber: "0T/44/2019- II.",
          metadata: { caseNumber: "0T/44/2019- II." },
        }),
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      const row = await db.query.caseLawDecisions.findFirst({
        where: {
          sourceId: { eq: sourceId },
          sourceDocumentId: "trailing-marker-document",
        },
        columns: { caseNumber: true, citationKey: true, metadata: true },
      });
      expect(row?.caseNumber).toBe("0T/44/2019");
      expect(row?.citationKey).toBe(bareCitationKey("0T/44/2019"));
      // The publisher's spelling survives in the adapter's metadata.
      expect(isRecord(row?.metadata) ? row.metadata["caseNumber"] : null).toBe(
        "0T/44/2019- II.",
      );
      expect(await storedSlugs(["trailing-marker-document"])).toEqual([
        "0t-44-2019",
      ]);
    });

    test("adopts a legacy row stored under the publisher's uncut docket", async () => {
      const caseNumber = "0T/45/2019- III.";
      const legacyUrl = "https://publisher.test/uncut-docket";
      await processDecision({
        input: plainTextIngestionResult({
          ...decisionAt("Uncut docket", undefined),
          caseNumber,
          sourceUrl: legacyUrl,
        }),
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });
      // Keyed by its docket, the legacy row keeps the tail that may be all
      // that separates it from a sibling.
      const [legacyRow] = await docketRows(caseNumber);
      expect(legacyRow?.sourceDocumentId).toBeNull();

      await processDecision({
        input: plainTextIngestionResult({
          ...decisionAt("Uncut docket", "uncut-docket-document"),
          caseNumber,
          legacySourceUrls: [legacyUrl],
          rawHash: "hash-uncut-docket-identified",
        }),
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      expect(await docketRows(caseNumber)).toEqual([]);
      expect(await docketRows("0T/45/2019")).toEqual([
        {
          id: legacyRow?.id ?? expect.unreachable(),
          sourceDocumentId: "uncut-docket-document",
        },
      ]);
    });

    test("proves each legacy candidate when the cut and uncut dockets both hold one", async () => {
      const uncut = "0T/46/2019- II.";
      const siblingUrl = "https://publisher.test/cut-docket-sibling";
      const legacyUrl = "https://publisher.test/uncut-docket-legacy";
      await processDecision({
        input: plainTextIngestionResult({
          ...decisionAt("Cut docket sibling", undefined),
          caseNumber: "0T/46/2019",
          sourceUrl: siblingUrl,
        }),
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });
      await processDecision({
        input: plainTextIngestionResult({
          ...decisionAt("Uncut docket legacy", undefined),
          caseNumber: uncut,
          sourceUrl: legacyUrl,
        }),
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });
      const [sibling] = await docketRows("0T/46/2019");
      const [legacyRow] = await docketRows(uncut);

      await processDecision({
        input: plainTextIngestionResult({
          ...decisionAt("Uncut docket legacy", "uncut-docket-legacy-document"),
          caseNumber: uncut,
          legacySourceUrls: [legacyUrl],
          rawHash: "hash-uncut-docket-legacy-identified",
        }),
        observationOrder: 3n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:02.000Z"),
      });

      expect(await docketRows(uncut)).toEqual([]);
      expect(await docketRows("0T/46/2019")).toEqual([
        {
          id: legacyRow?.id ?? expect.unreachable(),
          sourceDocumentId: "uncut-docket-legacy-document",
        },
        {
          id: sibling?.id ?? expect.unreachable(),
          sourceDocumentId: null,
        },
      ]);
    });

    test("keeps a legacy row whose ECLI names a sibling under the docket", async () => {
      const caseNumber = "Pl.ÚS 19/01";
      const legacyUrl = "https://publisher.test/sibling-ecli-legacy";
      await processDecision({
        input: plainTextIngestionResult({
          ...decisionAt(`Legacy ECLI ${caseNumber}`, undefined),
          caseNumber,
          ecli: "ECLI:CZ:US:2002:PL.US.19.01.1",
          sourceUrl: legacyUrl,
        }),
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });
      const [legacyRow] = await docketRows(caseNumber);

      // Same docket, same retrieval URL hint, but the second decision of the
      // docket: the URL alone must not pull the first decision's row over.
      await processDecision({
        input: plainTextIngestionResult({
          ...decisionAt(`Legacy ECLI ${caseNumber}`, "nalus-record:second"),
          caseNumber,
          ecli: "ECLI:CZ:US:2002:Pl.US.19.01.2",
          legacyEcli: "ECLI:CZ:US:2002:Pl.US.19.01.2",
          legacySourceUrls: [legacyUrl],
          rawHash: "hash-nalus-second",
        }),
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      const rows = await docketRows(caseNumber);
      expect(rows.map(({ sourceDocumentId }) => sourceDocumentId)).toEqual([
        "nalus-record:second",
        null,
      ]);
      expect(rows.at(1)?.id).toBe(legacyRow?.id);
    });

    test("replaces a listing placeholder when detail recovers the docket", async () => {
      const publisherId = "recovered-docket-publisher-id";
      const placeholder = plainTextIngestionResult({
        ...decisionAt("Recovered docket identity", publisherId),
        caseNumber: "NALUS record 7301",
        rawHash: "hash-listing-placeholder",
      });
      await processDecision({
        input: placeholder,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      const recoveredCaseNumber = "III.ÚS 81/24";
      await processDecision({
        input: plainTextIngestionResult({
          ...placeholder,
          caseNumber: recoveredCaseNumber,
          metadata: { ...placeholder.metadata, recoveredDetail: true },
          rawHash: "hash-recovered-docket",
        }),
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      await processDecision({
        input: plainTextIngestionResult({
          ...placeholder,
          caseNumber: "NALUS record 7301",
          caseNumberIsPlaceholder: true,
          metadata: {
            ...placeholder.metadata,
            listedOnly: true,
            listingDocketMissing: true,
          },
          rawHash: "hash-withdrawn-detail-placeholder",
        }),
        observationOrder: 3n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:02.000Z"),
      });

      const [row] = await db.execute(
        sql<{
          caseNumber: string;
          citationKey: string;
          metadata: Record<string, unknown>;
          sourceHash: string;
        }>`
          SELECT case_number AS "caseNumber",
                 citation_key AS "citationKey",
                 metadata,
                 source_hash AS "sourceHash"
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
      expect(isRecord(row) ? row["sourceHash"] : undefined).toBe(
        "hash-recovered-docket",
      );
      expect(
        isRecord(row) && isRecord(row["metadata"])
          ? row["metadata"]["recoveredDetail"]
          : undefined,
      ).toBe(true);
    });

    test("migrates an exact publisher-id alias without duplicating the row", async () => {
      const fallbackId = "nalus-sz:2-91-24_1";
      const canonicalId = "nalus-record:7391";
      const fallback = decisionAt("Publisher alias migration", fallbackId);
      await processDecision({
        input: fallback,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      await processDecision({
        input: plainTextIngestionResult({
          ...fallback,
          sourceDocumentId: canonicalId,
          sourceDocumentIdAliases: [fallbackId],
          rawHash: "hash-canonical-publisher-id",
        }),
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      const rows = await db.execute(sql<{
        count: number;
        canonicalCount: number;
        fallbackCount: number;
      }>`
        SELECT count(*)::int AS count,
               count(*) FILTER (
                 WHERE source_document_id = ${canonicalId}
               )::int AS "canonicalCount",
               count(*) FILTER (
                 WHERE source_document_id = ${fallbackId}
               )::int AS "fallbackCount"
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
          AND court = ${fallback.court}
      `);
      const row = Array.isArray(rows) ? rows.at(0) : undefined;
      expect(isRecord(row) ? Number(row["count"]) : 0).toBe(1);
      expect(isRecord(row) ? Number(row["canonicalCount"]) : 0).toBe(1);
      expect(isRecord(row) ? Number(row["fallbackCount"]) : 0).toBe(0);
    });

    test.each(["reserved", "legacy"] as const)(
      "adopts a stored raw-text NALUS quarantine identity after publisher recovery (%s)",
      async (identityState) => {
        const caseNumber =
          identityState === "reserved" ? "Pl.ÚS 46999/24" : "Pl.ÚS 46998/24";
        const publisherId =
          identityState === "reserved" ? "Pl-46999-24_1" : "Pl-46998-24_1";
        const legacyId = `nalus-quarantine:${hashContent(
          JSON.stringify({
            stablePrimaryText: "Jan NovákoldPrimary()",
            stableActionsText: "oldAction()",
            stableDetailText: caseNumber,
            stableCounterText: "1",
          }),
        )}`;
        const listing = `<html><body>Výsledky 1 - 1 z celkem 1
        <table>
          <tr class="resultData0"><td></td><td>
            <a href="ResultDetail.aspx?malformed=true&pos=1&cnt=1">${caseNumber} #1</a><br />
            Jan Novák<script>oldPrimary()</script>
          </td></tr>
          <tr class="resultData0" valign="top"><td>
            <img onclick='javascript:ShowLink("https://nalus.usoud.cz/Search/GetText.aspx?sz=${publisherId}", "Odkaz", "")' /><script>oldAction()</script>
          </td></tr>
        </table>Výsledky 1 - 1 z celkem 1</body></html>`;
        const sleepSpy = spyOn(Bun, "sleep").mockResolvedValue(undefined);
        const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
          asFetchMock(async (input, init) => {
            const url = new URL(
              input instanceof Request ? input.url : String(input),
            );
            if (url.pathname.endsWith("/Search/Search.aspx")) {
              if (init?.method === "POST") {
                return new Response(null, {
                  status: 302,
                  headers: { Location: "/Search/Results.aspx" },
                });
              }
              return new Response(`<html><body>
            <input id="__VIEWSTATE" value="view-state" />
            <input id="__VIEWSTATEGENERATOR" value="generator" />
            <input id="__EVENTVALIDATION" value="validation" />
            <select name="ctl00$MainContent$resultsPageSize" id="ctl00_MainContent_resultsPageSize">
              <option selected="selected" value="20">20</option>
            </select>
          </body></html>`);
            }
            if (url.pathname.endsWith("/Search/Results.aspx")) {
              return new Response(listing);
            }
            return new Response("missing", { status: 404 });
          }),
        );
        const page = await Result.tryPromise(
          async () =>
            await czUsAdapter.fetchPage(
              "search:historical:2026-08-07:2024:collect:0:0:-",
              {},
            ),
        );
        fetchSpy.mockRestore();
        sleepSpy.mockRestore();
        if (Result.isError(page)) {
          panic(page.error.message);
        }
        if (Result.isError(page.value)) {
          panic(page.value.error.message);
        }
        const recovered = page.value.value.decisions.at(0);
        expect(page.value.value.decisions).toHaveLength(1);
        if (!recovered?.sourceDocumentId) {
          panic("Expected recovered NALUS observation");
        }
        expect(recovered.sourceDocumentId).toBe(`nalus-sz:${publisherId}`);
        // Raw storage has its own integration tests; this suite exercises DB identity.
        const observation = {
          ...recovered,
          sourceRaw: undefined,
          sourceRawBytes: undefined,
        };
        expect(recovered.sourceDocumentIdRepairAliases).toContain(legacyId);
        expect(recovered.sourceDocumentIdAliases ?? []).not.toContain(legacyId);
        await processDecision({
          input: {
            ...observation,
            sourceDocumentId: legacyId,
            sourceDocumentIdAliases: undefined,
            sourceDocumentIdRepairAliases: undefined,
            rawHash: "legacy-nalus-script-quarantine",
          },
          observationOrder: 1n,
          sourceId,
          scopedDb,
          observedAt: new Date("2026-07-31T12:00:00.000Z"),
        });
        const [stored] = await db
          .select({ id: caseLawDecisions.id })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.sourceId, sourceId),
              eq(caseLawDecisions.sourceDocumentId, legacyId),
            ),
          );
        expect(stored).toBeDefined();
        if (!stored) {
          panic("Expected stored NALUS quarantine row");
        }
        if (identityState === "legacy") {
          await db
            .delete(caseLawDecisionSourceIdentities)
            .where(
              and(
                eq(caseLawDecisionSourceIdentities.sourceId, sourceId),
                eq(caseLawDecisionSourceIdentities.decisionId, stored.id),
              ),
            );
        }
        for (const observationOrder of [2n, 3n]) {
          await processDecision({
            input: observation,
            observationOrder,
            sourceId,
            scopedDb,
            observedAt: new Date("2026-07-31T12:00:01.000Z"),
          });
        }
        // A late identity-less listing must still resolve to the recovered row.
        await processDecision({
          input: {
            ...observation,
            sourceDocumentId: legacyId,
            sourceDocumentIdAliases: undefined,
            sourceDocumentIdRepairAliases: undefined,
            rawHash: "legacy-nalus-script-quarantine",
          },
          observationOrder: 4n,
          sourceId,
          scopedDb,
          observedAt: new Date("2026-07-31T12:00:02.000Z"),
        });
        const rows = await db
          .select({
            id: caseLawDecisions.id,
            sourceDocumentId: caseLawDecisions.sourceDocumentId,
          })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.sourceId, sourceId),
              eq(caseLawDecisions.caseNumber, caseNumber),
            ),
          );
        expect(rows).toEqual([
          { id: stored.id, sourceDocumentId: recovered.sourceDocumentId },
        ]);
      },
    );

    test("uses heuristic repair aliases only when an owner already exists", async () => {
      const quarantineId = "nalus-quarantine:known-repair";
      const recoveredId = "nalus-record:known-repair";
      const quarantined = decisionAt("Known repair alias", quarantineId);
      await processDecision({
        input: quarantined,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });
      await processDecision({
        input: plainTextIngestionResult({
          ...quarantined,
          sourceDocumentId: recoveredId,
          sourceDocumentIdRepairAliases: [quarantineId],
          rawHash: "hash-known-repair-recovered",
        }),
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });
      await processDecision({
        input: plainTextIngestionResult({
          ...decisionAt(
            "Distinct row after repair",
            "nalus-record:known-repair-collision",
          ),
          sourceDocumentIdRepairAliases: [quarantineId],
        }),
        observationOrder: 3n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:02.000Z"),
      });

      const unclaimedRepairId = "nalus-quarantine:shared-but-unclaimed";
      await Promise.all(
        ["nalus-record:distinct-a", "nalus-record:distinct-b"].map(
          async (publisherId, index) =>
            await processDecision({
              input: plainTextIngestionResult({
                ...decisionAt(`Distinct repair row ${index}`, publisherId),
                sourceDocumentIdRepairAliases: [unclaimedRepairId],
              }),
              observationOrder: BigInt(index + 4),
              sourceId,
              scopedDb,
              observedAt: new Date(`2026-07-31T12:00:0${index + 2}.000Z`),
            }),
        ),
      );

      const rows = await db.execute(sql<{
        recoveredCount: number;
        postRepairDistinctCount: number;
        distinctCount: number;
        unclaimedRepairCount: number;
      }>`
        SELECT (
                 SELECT count(*)::int
                 FROM case_law_decisions
                 WHERE source_id = ${sourceId}
                   AND court = ${quarantined.court}
                   AND source_document_id = ${recoveredId}
               ) AS "recoveredCount",
               (
                 SELECT count(*)::int
                 FROM case_law_decisions
                 WHERE source_id = ${sourceId}
                   AND court = 'Distinct row after repair'
                   AND source_document_id = 'nalus-record:known-repair-collision'
               ) AS "postRepairDistinctCount",
               (
                 SELECT count(*)::int
                 FROM case_law_decisions
                 WHERE source_id = ${sourceId}
                   AND court LIKE 'Distinct repair row %'
               ) AS "distinctCount",
               (
                 SELECT count(*)::int
                 FROM case_law_decision_source_identities
                 WHERE source_id = ${sourceId}
                   AND source_document_id = ${unclaimedRepairId}
               ) AS "unclaimedRepairCount"
      `);
      const row = Array.isArray(rows) ? rows.at(0) : undefined;
      expect(isRecord(row) ? Number(row["recoveredCount"]) : 0).toBe(1);
      expect(isRecord(row) ? Number(row["postRepairDistinctCount"]) : 0).toBe(
        1,
      );
      expect(isRecord(row) ? Number(row["distinctCount"]) : 0).toBe(2);
      expect(isRecord(row) ? Number(row["unclaimedRepairCount"]) : -1).toBe(0);
    });

    test.each(["reserved", "legacy"] as const)(
      "does not adopt ambiguous quarantine owners (%s)",
      async (identityState) => {
        const quarantineIds = [
          `quarantine:${identityState}:a`,
          `quarantine:${identityState}:b`,
        ];
        for (const quarantineId of quarantineIds) {
          await processDecision({
            input: decisionAt("Ambiguous repair", quarantineId),
            observationOrder: 1n,
            sourceId,
            scopedDb,
            observedAt: new Date("2026-07-31T12:00:00.000Z"),
          });
        }
        if (identityState === "legacy") {
          await db
            .delete(caseLawDecisionSourceIdentities)
            .where(
              and(
                eq(caseLawDecisionSourceIdentities.sourceId, sourceId),
                inArray(
                  caseLawDecisionSourceIdentities.sourceDocumentId,
                  quarantineIds,
                ),
              ),
            );
        }
        const canonicalId = `canonical:${identityState}:ambiguous`;
        for (const observationOrder of [2n, 3n]) {
          await processDecision({
            input: {
              ...decisionAt("Ambiguous repair", canonicalId),
              sourceDocumentIdRepairAliases: quarantineIds,
            },
            observationOrder,
            sourceId,
            scopedDb,
            observedAt: new Date("2026-07-31T12:00:01.000Z"),
          });
        }
        const rows = await db
          .select({ sourceDocumentId: caseLawDecisions.sourceDocumentId })
          .from(caseLawDecisions)
          .where(
            and(
              eq(caseLawDecisions.sourceId, sourceId),
              inArray(caseLawDecisions.sourceDocumentId, [
                ...quarantineIds,
                canonicalId,
              ]),
            ),
          );
        const storedIds = rows.map(({ sourceDocumentId }) => sourceDocumentId);
        // The expected ids are distinct, so length plus containment is equality.
        expect(storedIds).toHaveLength(quarantineIds.length + 1);
        expect(storedIds).toEqual(
          expect.arrayContaining([...quarantineIds, canonicalId]),
        );
      },
    );

    test("keeps canonical ownership when a later observation has only a fallback", async () => {
      const canonicalId = "nalus-record:inverse-7391";
      const fallbackId = "nalus-sz:inverse-2-91-24_1";
      const canonical = plainTextIngestionResult({
        ...decisionAt("Inverse publisher alias", canonicalId),
        sourceDocumentIdAliases: [fallbackId],
      });
      await processDecision({
        input: canonical,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      await processDecision({
        input: {
          ...canonical,
          sourceDocumentId: fallbackId,
          sourceDocumentIdAliases: undefined,
          rawHash: "hash-inverse-fallback",
        },
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      const rows = await db.execute(sql<{
        count: number;
        canonicalCount: number;
        fallbackCount: number;
      }>`
        SELECT count(*)::int AS count,
               count(*) FILTER (
                 WHERE source_document_id = ${canonicalId}
               )::int AS "canonicalCount",
               count(*) FILTER (
                 WHERE source_document_id = ${fallbackId}
               )::int AS "fallbackCount"
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
          AND court = ${canonical.court}
      `);
      const row = Array.isArray(rows) ? rows.at(0) : undefined;
      expect(isRecord(row) ? Number(row["count"]) : 0).toBe(1);
      expect(isRecord(row) ? Number(row["canonicalCount"]) : 0).toBe(1);
      expect(isRecord(row) ? Number(row["fallbackCount"]) : 0).toBe(0);
    });

    test("atomically reserves one row for concurrent canonical and fallback observations", async () => {
      const canonicalId = "nalus-record:concurrent-7391";
      const fallbackId = "nalus-sz:concurrent-2-91-24_1";
      const base = decisionAt("Concurrent publisher alias", canonicalId);
      let reservationsCompleted = 0;
      let releaseReservations = (): void => undefined;
      const bothReserved = new Promise<void>((resolve) => {
        releaseReservations = resolve;
      });
      const concurrentDb: ScopedDb = async (transactionWork) => {
        const value = await scopedDb(transactionWork);
        reservationsCompleted += 1;
        if (reservationsCompleted <= 2) {
          if (reservationsCompleted === 2) {
            releaseReservations();
          }
          await bothReserved;
        }
        return value;
      };

      const outcomes = await Promise.all([
        processDecision({
          input: plainTextIngestionResult({
            ...base,
            sourceDocumentIdAliases: [fallbackId],
          }),
          observationOrder: 1n,
          sourceId,
          scopedDb: concurrentDb,
          observedAt: new Date("2026-07-31T12:00:00.000Z"),
        }),
        processDecision({
          input: plainTextIngestionResult({
            ...base,
            sourceDocumentId: fallbackId,
            rawHash: "hash-concurrent-fallback",
          }),
          observationOrder: 2n,
          sourceId,
          scopedDb: concurrentDb,
          observedAt: new Date("2026-07-31T12:00:01.000Z"),
        }),
      ]);

      expect(outcomes.every(({ status }) => status === "complete")).toBe(true);
      const rows = await db.execute(sql<{
        decisionCount: number;
        ownerCount: number;
      }>`
        SELECT (
                 SELECT count(*)::int
                 FROM case_law_decisions
                 WHERE source_id = ${sourceId}
                   AND court = ${base.court}
               ) AS "decisionCount",
               (
                 SELECT count(DISTINCT decision_id)::int
                 FROM case_law_decision_source_identities
                 WHERE source_id = ${sourceId}
                   AND source_document_id IN (${canonicalId}, ${fallbackId})
               ) AS "ownerCount"
      `);
      const row = Array.isArray(rows) ? rows.at(0) : undefined;
      expect(isRecord(row) ? Number(row["decisionCount"]) : 0).toBe(1);
      expect(isRecord(row) ? Number(row["ownerCount"]) : 0).toBe(1);
    });

    test("preserves recovered detail on a listing-only refresh with a valid docket", async () => {
      const publisherId = "listing-only-preserves-detail";
      const recovered = decisionAt("Recovered detail court", publisherId);
      await processDecision({
        input: recovered,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      await processDecision({
        input: plainTextIngestionResult({
          ...recovered,
          fulltext: undefined,
          isListingOnly: true,
          metadata: { listedOnly: true },
          rawHash: "degraded-listing-hash",
        }),
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      const [row] = await db.execute(
        sql<{
          court: string;
          fulltext: string;
          metadata: Record<string, unknown>;
          observationHash: string;
          sourceHash: string;
        }>`
          SELECT court,
                 fulltext,
                 metadata,
                 source_observation_hash AS "observationHash",
                 source_hash AS "sourceHash"
          FROM case_law_decisions
          WHERE source_id = ${sourceId}
            AND source_document_id = ${publisherId}
        `,
      );
      expect(row).toMatchObject({
        court: recovered.court,
        fulltext: recovered.fulltext,
        observationHash: "degraded-listing-hash",
        sourceHash: recovered.rawHash,
      });
      expect(
        isRecord(row) && isRecord(row["metadata"])
          ? row["metadata"]["court"]
          : undefined,
      ).toBe(recovered.court);
    });

    test("allows a better listing-only observation to replace an earlier partial row", async () => {
      const publisherId = "listing-only-enrichment";
      const partial = plainTextIngestionResult({
        ...decisionAt("Partial listing court", publisherId),
        caseNumber: "NALUS record 8801",
        caseNumberIsPlaceholder: true,
        fulltext: undefined,
        isListingOnly: true,
        metadata: { listedOnly: true, listingDocketMissing: true },
        rawHash: "hash-partial-placeholder",
      });
      await processDecision({
        input: partial,
        observationOrder: 1n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:00.000Z"),
      });

      const recoveredCaseNumber = "II.ÚS 8801/24";
      await processDecision({
        input: plainTextIngestionResult({
          ...partial,
          caseNumber: recoveredCaseNumber,
          caseNumberIsPlaceholder: undefined,
          metadata: { listedOnly: true, listingDocketMissing: false },
          rawHash: "hash-partial-with-docket",
        }),
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      const [row] = await db.execute(
        sql<{
          caseNumber: string;
          citationKey: string;
          metadata: Record<string, unknown>;
          sourceHash: string;
        }>`
          SELECT case_number AS "caseNumber",
                 citation_key AS "citationKey",
                 metadata,
                 source_hash AS "sourceHash"
          FROM case_law_decisions
          WHERE source_id = ${sourceId}
            AND source_document_id = ${publisherId}
        `,
      );
      expect(row).toMatchObject({
        caseNumber: recoveredCaseNumber,
        citationKey: bareCitationKey(recoveredCaseNumber),
        sourceHash: "hash-partial-with-docket",
      });
      expect(
        isRecord(row) && isRecord(row["metadata"])
          ? row["metadata"]["listingDocketMissing"]
          : undefined,
      ).toBe(false);
    });

    test("binds a legacy row before a listing-only preservation return", async () => {
      const publisherId = "listing-only-legacy-binding";
      const legacyUrl = "https://publisher.test/listing-only-legacy";
      const legacy = plainTextIngestionResult({
        ...decisionAt("Listing-only legacy", undefined),
        sourceUrl: legacyUrl,
      });
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
          sourceDocumentId: publisherId,
          legacySourceUrls: [legacyUrl],
          fulltext: undefined,
          isListingOnly: true,
          metadata: { listedOnly: true },
          rawHash: "hash-listing-only-binding",
        },
        observationOrder: 2n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:01.000Z"),
      });

      await processDecision({
        input: {
          ...legacy,
          sourceDocumentId: publisherId,
          sourceUrl: "https://publisher.test/current-listing",
          fulltext: undefined,
          isListingOnly: true,
          metadata: { listedOnly: true },
          rawHash: "hash-listing-only-without-legacy-hint",
        },
        observationOrder: 3n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:00:02.000Z"),
      });

      const rows = await db.execute(sql<{ count: number; identified: number }>`
        SELECT count(*)::int AS count,
               count(*) FILTER (
                 WHERE source_document_id = ${publisherId}
               )::int AS identified
        FROM case_law_decisions
        WHERE source_id = ${sourceId}
          AND court = ${legacy.court}
      `);
      const row = Array.isArray(rows) ? rows.at(0) : undefined;
      expect(isRecord(row) ? Number(row["count"]) : 0).toBe(1);
      expect(isRecord(row) ? Number(row["identified"]) : 0).toBe(1);
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
        // The run reads its source schema once before reading the identity.
        if (call === 1) {
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

    test("a parse failure preserves text from the locked row", async () => {
      const publisherId = "parse-failure-contention";
      type DecisionWithAbstractOptions = {
        rawHash: string;
        text: string;
      };
      const decisionWithAbstract = ({
        rawHash,
        text,
      }: DecisionWithAbstractOptions) =>
        plainTextIngestionResult({
          ...decisionAt("Fixture court", publisherId),
          textFields: {
            ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
            abstract: presentTextField(text),
          },
          rawHash,
        });
      const initial = decisionWithAbstract({
        rawHash: "initial-hash",
        text: "Initial abstract",
      });
      const intervening = decisionWithAbstract({
        rawHash: "intervening-hash",
        text: "Intervening abstract",
      });
      const parseFailure = plainTextIngestionResult({
        ...decisionAt("Fixture court", publisherId),
        textFields: {
          ...absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
          abstract: absentTextField(TEXT_ABSENCE_REASON.PARSE_FAILED),
        },
        rawHash: "parse-failure-hash",
      });

      await processDecision({
        input: initial,
        observationOrder: 33n,
        sourceId,
        scopedDb,
        observedAt: new Date("2000-01-01T00:00:03.000Z"),
      });

      let releaseParseFailure = (): void => undefined;
      const parseFailureMayContinue = new Promise<void>((resolve) => {
        releaseParseFailure = resolve;
      });
      let parseFailureReadCompleted = (): void => undefined;
      const parseFailureHasRead = new Promise<void>((resolve) => {
        parseFailureReadCompleted = resolve;
      });
      let parseFailureCallCount = 0;
      const parseFailureDb: ScopedDb = async (transactionWork) => {
        const call = parseFailureCallCount;
        parseFailureCallCount += 1;
        const value = await scopedDb(transactionWork);
        // The run reads its source schema once before reading the identity.
        if (call === 1) {
          parseFailureReadCompleted();
          await parseFailureMayContinue;
        }
        return value;
      };

      const laterObservation = processDecision({
        input: parseFailure,
        observationOrder: 35n,
        sourceId,
        scopedDb: parseFailureDb,
        observedAt: new Date("2000-01-01T00:00:05.000Z"),
      });
      await parseFailureHasRead;
      await processDecision({
        input: intervening,
        observationOrder: 34n,
        sourceId,
        scopedDb,
        observedAt: new Date("2000-01-01T00:00:04.000Z"),
      });
      releaseParseFailure();
      await laterObservation;

      const row = (
        await db.execute(
          sql<{ abstract: string | null; observationOrder: bigint }>`
          SELECT metadata ->> 'abstract' AS abstract,
                 source_observation_order AS "observationOrder"
          FROM case_law_decisions
          WHERE source_id = ${sourceId}
            AND source_document_id = ${publisherId}
        `,
        )
      ).at(0);
      expect(row).toMatchObject({
        abstract: "Intervening abstract",
        observationOrder: 35n,
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
        // One schema lookup precedes the identity read in this standalone run.
        if (transactions === 3) {
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

      expect(transactions).toBe(4);
      expect(outcome).toEqual({
        status: "retryable",
        inserted: false,
        reason: "corpus-write",
      });
    });

    test("a listing-only watermark race holds a pending winner for replay", async () => {
      const publisherId = "listing-only-watermark-pending-winner";
      const initial = decisionAt("Listing-only race detail", publisherId);

      await processDecision({
        input: initial,
        observationOrder: 50n,
        sourceId,
        scopedDb,
        observedAt: new Date("2026-07-31T12:05:00.000Z"),
      });

      let transactions = 0;
      const racingDb: ScopedDb = async (transactionWork) => {
        transactions += 1;
        // One schema lookup precedes the identity read in this standalone run.
        if (transactions === 3) {
          await db
            .update(caseLawDecisions)
            .set({
              corpusMirrorStatus: CASE_LAW_CORPUS_MIRROR_STATUS.PENDING,
              sourceObservationOrder: 52n,
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
        input: plainTextIngestionResult({
          ...initial,
          fulltext: undefined,
          isListingOnly: true,
          metadata: { listedOnly: true },
          rawHash: "hash-listing-only-watermark-race",
        }),
        observationOrder: 51n,
        sourceId,
        scopedDb: racingDb,
        observedAt: new Date("2026-07-31T12:05:01.000Z"),
      });

      expect(transactions).toBe(4);
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

    test("concurrent inserts racing for a free base slug take it and one deterministic candidate", async () => {
      const racer = (publisherId: string) =>
        plainTextIngestionResult({
          ...decisionAt("Okresný súd Race", publisherId),
          caseNumber: "7Co/31/2024",
        });
      const failures: unknown[] = [];
      const recordingDb: ScopedDb = async (transactionWork) => {
        try {
          return await scopedDb(transactionWork);
        } catch (error) {
          failures.push(error);
          throw error;
        }
      };

      await Promise.all(
        ["race-a", "race-b"].map(
          async (publisherId) =>
            await processDecision({
              input: racer(publisherId),
              observationOrder: 1n,
              sourceId,
              scopedDb: recordingDb,
              observedAt: new Date("2026-07-31T12:00:00.000Z"),
            }),
        ),
      );

      const candidate = (publisherId: string) =>
        createCaseLawDecisionSlugCandidate({
          baseSlug: "7co-31-2024",
          identity: `${sourceId}\u0000document\u0000${publisherId}`,
          attempt: 1,
        });
      const [slugA, slugB] = await storedSlugs(["race-a", "race-b"]);
      expect([slugA, slugB]).toEqual(
        slugA === "7co-31-2024"
          ? ["7co-31-2024", candidate("race-b")]
          : [candidate("race-a"), "7co-31-2024"],
      );
      // The loser moved to its candidate inside its own row write.
      expect(failures).toEqual([]);
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
        const result = await scopedDb(async (tx) => await transactionWork(tx));
        // The run reads its source schema once before reading the identity.
        if (call === 1) {
          await synchronizeInitialRead();
        }
        return result;
      };

      let secondCallCount = 0;
      const secondScopedDb: ScopedDb = async (transactionWork) => {
        const call = secondCallCount;
        secondCallCount += 1;
        const result = await scopedDb(async (tx) => await transactionWork(tx));
        // The run reads its source schema once before reading the identity.
        if (call === 1) {
          await synchronizeInitialRead();
          await firstWriteCompleted;
        }
        return result;
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

    test("Postgres aliases preserve identity across replay, flattening and retirement", async () => {
      const first = createSafeId<"caseLawDecision">();
      const middle = createSafeId<"caseLawDecision">();
      const terminal = createSafeId<"caseLawDecision">();
      const later = createSafeId<"caseLawDecision">();
      const missing = createSafeId<"caseLawDecision">();
      await db.insert(caseLawDecisions).values(
        [first, middle, terminal, later].map((id) => ({
          id,
          sourceId,
          country: "SVK",
          court: "Alias lifecycle court",
          language: "sk",
          caseNumber: id,
        })),
      );
      const alias = {
        retiredDecisionId: first,
        canonicalDecisionId: middle,
      };
      await db.insert(caseLawDecisionAliases).values(alias);
      const initial = await db
        .select()
        .from(caseLawDecisionAliases)
        .where(eq(caseLawDecisionAliases.retiredDecisionId, first));
      expect(initial).toMatchObject([alias]);
      await db
        .insert(caseLawDecisionAliases)
        .values(alias)
        .onConflictDoUpdate({
          target: caseLawDecisionAliases.retiredDecisionId,
          set: { canonicalDecisionId: middle },
        });
      expect(
        await db
          .select()
          .from(caseLawDecisionAliases)
          .where(eq(caseLawDecisionAliases.retiredDecisionId, first)),
      ).toEqual(initial);

      expect(
        await rejectionOf(
          db
            .insert(caseLawDecisionAliases)
            .values({ retiredDecisionId: middle, canonicalDecisionId: first })
            .execute(),
        ),
      ).toMatchObject({
        cause: { message: expect.stringContaining("Decision alias cycle") },
      });
      expect(
        await rejectionOf(
          db
            .insert(caseLawDecisionAliases)
            .values({ retiredDecisionId: later, canonicalDecisionId: missing })
            .execute(),
        ),
      ).toMatchObject({
        cause: {
          message: expect.stringContaining("Decision alias target is not live"),
        },
      });
      expect(
        await rejectionOf(
          db
            .insert(caseLawDecisionAliases)
            .values({
              retiredDecisionId: missing,
              canonicalDecisionId: terminal,
            })
            .execute(),
        ),
      ).toMatchObject({
        cause: {
          message: expect.stringContaining(
            "Register decision alias before retirement",
          ),
        },
      });
      for (const patch of [
        { canonicalDecisionId: terminal },
        { retiredDecisionId: later },
        { createdAt: new Date("2000-01-01T00:00:00Z") },
      ]) {
        expect(
          await rejectionOf(
            db
              .update(caseLawDecisionAliases)
              .set(patch)
              .where(eq(caseLawDecisionAliases.retiredDecisionId, first))
              .execute(),
          ),
        ).toMatchObject({
          cause: {
            message: expect.stringContaining(
              "canonicalDecisionId" in patch
                ? "Conflicting decision alias target"
                : "Decision alias identity is immutable",
            ),
          },
        });
      }
      expect(
        await rejectionOf(
          db
            .delete(caseLawDecisions)
            .where(eq(caseLawDecisions.id, middle))
            .execute(),
        ),
      ).toMatchObject({
        cause: {
          code: "ERR_POSTGRES_SERVER_ERROR",
          errno: "23001",
          message: expect.stringContaining(
            "case_law_decision_aliases_canonical_fk",
          ),
        },
      });
      await db.insert(caseLawDecisionAliases).values({
        retiredDecisionId: middle,
        canonicalDecisionId: terminal,
      });
      await db
        .delete(caseLawDecisions)
        .where(inArray(caseLawDecisions.id, [first, middle]));
      await db
        .insert(caseLawDecisionAliases)
        .values(alias)
        .onConflictDoUpdate({
          target: caseLawDecisionAliases.retiredDecisionId,
          set: { canonicalDecisionId: middle },
        });
      await db.insert(caseLawDecisionAliases).values({
        retiredDecisionId: later,
        canonicalDecisionId: first,
      });
      const rows = await db
        .select({
          retired: caseLawDecisionAliases.retiredDecisionId,
          target: caseLawDecisionAliases.canonicalDecisionId,
        })
        .from(caseLawDecisionAliases)
        .where(
          inArray(caseLawDecisionAliases.retiredDecisionId, [
            first,
            middle,
            later,
          ]),
        );
      expect(rows).toHaveLength(3);
      for (const retired of [first, middle, later]) {
        expect(rows).toContainEqual({ retired, target: terminal });
      }
      expect(
        await rejectionOf(
          db
            .delete(caseLawDecisions)
            .where(eq(caseLawDecisions.id, terminal))
            .execute(),
        ),
      ).toMatchObject({
        cause: {
          code: "ERR_POSTGRES_SERVER_ERROR",
          errno: "23001",
          message: expect.stringContaining(
            "case_law_decision_aliases_canonical_fk",
          ),
        },
      });
      expect(
        await rejectionOf(
          db
            .insert(caseLawDecisions)
            .values({
              id: first,
              sourceId,
              country: "SVK",
              court: "Alias lifecycle court",
              language: "sk",
              caseNumber: first,
            })
            .execute(),
        ),
      ).toMatchObject({
        cause: { message: expect.stringContaining("Decision UUID is retired") },
      });
      expect(
        await rejectionOf(
          db
            .update(caseLawDecisions)
            .set({ id: first })
            .where(eq(caseLawDecisions.id, later))
            .execute(),
        ),
      ).toMatchObject({
        cause: { message: expect.stringContaining("Decision UUID is retired") },
      });
    });
  });
}
