import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawSources, relations } from "@/api/db/schema";
import { EMPTY_AST } from "@/api/handlers/case-law/ingestion/adapter";
import type { IngestionResult } from "@/api/handlers/case-law/ingestion/adapter";
import { processDecision } from "@/api/handlers/case-law/ingestion/pipeline";
import type { SafeId } from "@/api/lib/branded-types";

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
      return list.map((row) => String((row as { court: unknown }).court));
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
      await processDecision(
        decisionAt("Okresný súd Prievidza", "g1"),
        sourceId,
        scopedDb,
      );
      await processDecision(
        decisionAt("Okresný súd Trenčín", "g2"),
        sourceId,
        scopedDb,
      );

      expect(await storedCourts()).toEqual([
        "Okresný súd Prievidza",
        "Okresný súd Trenčín",
      ]);
    });

    test("treats the same publisher id as the same decision on replay", async () => {
      const before = await storedCourts();
      await processDecision(
        decisionAt("Okresný súd Prievidza", "g1"),
        sourceId,
        scopedDb,
      );

      expect(await storedCourts()).toEqual(before);
    });
  });
}
