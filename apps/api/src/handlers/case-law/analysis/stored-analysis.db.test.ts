/**
 * A generation run takes the row by compare-and-swap on the `analysis`
 * value the request read, so it is tested against Postgres: the swap is a
 * `jsonb` equality over a value that travelled through the driver, and
 * getting it wrong either lets two runs start or lets none start (the
 * client then polls forever).
 *
 * Runs in the nightly Postgres job; skipped elsewhere.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { authRelationsPart } from "@/api/db/auth-schema";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { SafeId } from "@/api/lib/branded-types";

import { analysisSentinel, claimableAnalysisRow } from "./stored-analysis";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("analysis claim — compare-and-swap on the stored value", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("analysis claim — compare-and-swap on the stored value", () => {
    const db = drizzle(databaseUrl, {
      relations: { ...relations, ...authRelationsPart },
    });

    const NOW = new Date("2026-09-01T12:00:00.000Z");
    const CURRENT = "c".repeat(64);
    const PREVIOUS = "p".repeat(64);

    let sourceId: SafeId<"caseLawSource">;
    const created: SafeId<"caseLawDecision">[] = [];
    const suffix = Bun.randomUUIDv7().slice(0, 8);

    /** Writes any JSON value, including shapes the column type forbids. */
    const insertDecision = async (analysis: unknown) => {
      const [row] = await db
        .insert(caseLawDecisions)
        .values({
          sourceId,
          caseNumber: `claim-${created.length}-${suffix}`,
          court: "Okresný súd",
          country: "SVK",
          language: "sk",
        })
        .returning({ id: caseLawDecisions.id });
      if (!row) {
        throw new Error("expected decision row");
      }
      created.push(row.id);
      if (analysis !== null) {
        await db
          .update(caseLawDecisions)
          .set({
            analysis: sql`${JSON.stringify(analysis)}::text::jsonb`,
          })
          .where(eq(caseLawDecisions.id, row.id));
      }
      return row.id;
    };

    const readBack = async (decisionId: SafeId<"caseLawDecision">) => {
      const row = await db.query.caseLawDecisions.findFirst({
        where: { id: { eq: decisionId } },
        columns: { analysis: true },
      });
      return row?.analysis ?? null;
    };

    /** Attempts the swap and reports whether this request won it. */
    const claim = async (
      decisionId: SafeId<"caseLawDecision">,
      observed: unknown,
    ): Promise<boolean> => {
      const updated = await db
        .update(caseLawDecisions)
        .set({ analysis: analysisSentinel(CURRENT, NOW) })
        .where(claimableAnalysisRow({ decisionId, observed }))
        .returning({ id: caseLawDecisions.id });
      return updated.length === 1;
    };

    beforeAll(async () => {
      const existing = await db.query.caseLawSources.findFirst({
        where: { adapterKey: { eq: ADAPTER_KEYS.SK_COURTS } },
        columns: { id: true },
      });
      if (existing) {
        sourceId = existing.id;
        return;
      }
      const [source] = await db
        .insert(caseLawSources)
        .values({
          adapterKey: ADAPTER_KEYS.SK_COURTS,
          name: "SK courts analysis-claim test",
          enabled: false,
        })
        .returning({ id: caseLawSources.id });
      if (!source) {
        throw new Error("expected source row");
      }
      sourceId = source.id;
    });

    afterAll(async () => {
      if (created.length > 0) {
        await db
          .delete(caseLawDecisions)
          .where(inArray(caseLawDecisions.id, created));
      }
    });

    test("an empty row is taken by observing null, and only once", async () => {
      const decisionId = await insertDecision(null);
      expect(await claim(decisionId, null)).toBe(true);
      expect(await claim(decisionId, null)).toBe(false);
      expect(await readBack(decisionId)).toEqual(
        analysisSentinel(CURRENT, NOW),
      );
    });

    test("a JSON null in the column reads as null and is taken the same way", async () => {
      const decisionId = await insertDecision(null);
      await db
        .update(caseLawDecisions)
        .set({ analysis: sql`'null'::jsonb` })
        .where(eq(caseLawDecisions.id, decisionId));
      expect(await readBack(decisionId)).toBeNull();
      expect(await claim(decisionId, null)).toBe(true);
    });

    test("the value as the driver returned it matches, whatever its key order", async () => {
      const stale = analysisSentinel(PREVIOUS, NOW);
      const decisionId = await insertDecision(stale);
      const observed = await readBack(decisionId);
      expect(observed).not.toBeNull();
      expect(await claim(decisionId, observed)).toBe(true);
      expect(await claim(decisionId, observed)).toBe(false);
    });

    test("a shape the parser rejects is still swappable when observed as read", async () => {
      const malformed = {
        version: 2,
        inputFingerprint: CURRENT,
        generatedAt: "2026-08-31T09:00:00.000Z",
        model: "test-model",
        tree: [{ id: "missing-required-fields" }],
      };
      const decisionId = await insertDecision(malformed);
      const observed = await readBack(decisionId);
      expect(await claim(decisionId, observed)).toBe(true);
    });

    test("a row that changed underneath is not taken", async () => {
      const decisionId = await insertDecision(analysisSentinel(PREVIOUS, NOW));
      const observed = await readBack(decisionId);
      await db
        .update(caseLawDecisions)
        .set({ analysis: analysisSentinel(CURRENT, NOW) })
        .where(eq(caseLawDecisions.id, decisionId));
      expect(await claim(decisionId, observed)).toBe(false);
    });
  });
}
