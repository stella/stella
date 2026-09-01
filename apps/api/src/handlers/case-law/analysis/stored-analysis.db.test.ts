/**
 * Which rows a generation run may take is decided inside the UPDATE, in
 * SQL over the row's `analysis` JSON, so it is tested against Postgres:
 * the JS reading (`storedAnalysisState`) and the SQL reading
 * (`claimableAnalysisRow`) must agree, or a stale analysis is either
 * served forever or regenerated on every open.
 *
 * Runs in the nightly Postgres job; skipped elsewhere.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import type { PersistedDecisionAnalysis } from "@stll/legal-ast/analysis";

import { authRelationsPart } from "@/api/db/auth-schema";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import type { SafeId } from "@/api/lib/branded-types";

import {
  analysisSentinel,
  claimableAnalysisRow,
  SENTINEL_STALE_MS,
  storedAnalysisState,
} from "./stored-analysis";

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !runPostgresTests) {
  describe.skip("analysis claim — stored analysis state in SQL", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {
      expect(runPostgresTests && Boolean(databaseUrl)).toBe(false);
    });
  });
} else {
  describe("analysis claim — stored analysis state in SQL", () => {
    const db = drizzle(databaseUrl, {
      relations: { ...relations, ...authRelationsPart },
    });

    const NOW = new Date("2026-09-01T12:00:00.000Z");
    const CURRENT = "c".repeat(64);
    const PREVIOUS = "p".repeat(64);

    const analysisOver = (fingerprint: string): PersistedDecisionAnalysis => ({
      version: 2,
      generatedAt: "2026-08-31T09:00:00.000Z",
      model: "test-model",
      inputFingerprint: fingerprint,
      tree: [],
    });

    let sourceId: SafeId<"caseLawSource">;
    const created: SafeId<"caseLawDecision">[] = [];
    const suffix = Bun.randomUUIDv7().slice(0, 8);

    const insertDecision = async (
      analysis: PersistedDecisionAnalysis | null,
    ) => {
      const [row] = await db
        .insert(caseLawDecisions)
        .values({
          sourceId,
          caseNumber: `claim-${created.length}-${suffix}`,
          court: "Okresný súd",
          country: "SVK",
          language: "sk",
          analysis,
        })
        .returning({ id: caseLawDecisions.id });
      if (!row) {
        throw new Error("expected decision row");
      }
      created.push(row.id);
      return row.id;
    };

    const claimable = async (
      decisionId: SafeId<"caseLawDecision">,
    ): Promise<boolean> => {
      const rows = await db
        .select({ id: caseLawDecisions.id })
        .from(caseLawDecisions)
        .where(
          claimableAnalysisRow({ decisionId, fingerprint: CURRENT, now: NOW }),
        );
      return rows.length === 1;
    };

    const storedOf = async (decisionId: SafeId<"caseLawDecision">) => {
      const row = await db.query.caseLawDecisions.findFirst({
        where: { id: { eq: decisionId } },
        columns: { analysis: true },
      });
      return row?.analysis ?? null;
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

    const cases: {
      name: string;
      stored: PersistedDecisionAnalysis | null;
    }[] = [
      { name: "no analysis", stored: null },
      {
        name: "an analysis over the current input",
        stored: analysisOver(CURRENT),
      },
      {
        name: "an analysis over a previous parse",
        stored: analysisOver(PREVIOUS),
      },
      {
        name: "a fresh sentinel over the current input",
        stored: analysisSentinel(CURRENT, new Date(NOW.getTime() - 1000)),
      },
      {
        name: "a sentinel over the current input that outlived its run",
        stored: analysisSentinel(
          CURRENT,
          new Date(NOW.getTime() - SENTINEL_STALE_MS - 1000),
        ),
      },
      {
        name: "a fresh sentinel over a previous parse",
        stored: analysisSentinel(PREVIOUS, new Date(NOW.getTime() - 1000)),
      },
    ];

    for (const { name, stored } of cases) {
      test(`SQL agrees with the JS reading for ${name}`, async () => {
        const decisionId = await insertDecision(stored);
        const inJs = storedAnalysisState({
          stored,
          fingerprint: CURRENT,
          now: NOW,
        });
        expect(await claimable(decisionId)).toBe(inJs.kind === "none");
      });
    }

    test("a version-1 row, which carries no fingerprint, is claimable", async () => {
      const decisionId = await insertDecision(null);
      // The column type is the current shape; the historical one is written
      // as a literal on purpose, to prove the claim treats it as stale.
      const v1Row = JSON.stringify({
        version: 1,
        generatedAt: "2026-08-31T09:00:00.000Z",
        model: "test-model",
        tree: [],
      });
      await db
        .update(caseLawDecisions)
        .set({ analysis: sql.raw(`'${v1Row}'::jsonb`) })
        .where(eq(caseLawDecisions.id, decisionId));
      expect(await claimable(decisionId)).toBe(true);
      expect(await storedOf(decisionId)).not.toBeNull();
    });
  });
}
