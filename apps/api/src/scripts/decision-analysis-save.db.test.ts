/**
 * The save path against a real database.
 *
 * The fences are compare-and-swaps over a `jsonb` column, so getting them
 * wrong in SQL is invisible to a mocked store: a save could overwrite a
 * running generation, or an idempotent retry could write a second time.
 * This drives `applyAnalysisUpdate` through the row-backed store the
 * operator script uses, over the same statements it issues in production.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import type { PersistedDecisionAnalysis } from "@stll/legal-ast/analysis";
import { parsePersistedDecisionAnalysis } from "@stll/legal-ast/analysis";

import { caseLawDecisions, caseLawSources } from "@/api/db/schema";
import type { AnalysisOutput } from "@/api/handlers/case-law/analysis/analysis-output";
import { createDbAnalysisStore } from "@/api/handlers/case-law/analysis/analysis-store-core";
import { applyAnalysisUpdate } from "@/api/handlers/case-law/analysis/analysis-update";
import type { AnalysisSubject } from "@/api/handlers/case-law/analysis/analysis-update";
import { analysisSentinel } from "@/api/handlers/case-law/analysis/stored-analysis";
import type { SafeId } from "@/api/lib/branded-types";
import type { AnalysisInput } from "@/api/lib/case-law/analysis-prompt";
import { ADAPTER_KEYS } from "@/api/lib/legal-search/ingestion-constants";
import { getTestDb, releaseTestDb } from "@/api/tests/security/test-utils";
import type { TestDatabase } from "@/api/tests/security/test-utils";

const FINGERPRINT = "f".repeat(64);
const CONTENT_HASH = "c".repeat(64);
const NOW = new Date("2026-09-01T12:00:00.000Z");

const input: AnalysisInput = {
  language: "cs",
  systemPrompt: "system",
  userMessage: "user",
  fingerprint: FINGERPRINT,
};

const OUTPUT: AnalysisOutput = {
  headings: [
    {
      id: "",
      label: "Odůvodnění",
      category: "reasoning",
      startAnchorId: "b2",
      endAnchorId: "b2",
      annotations: [],
    },
  ],
  holding: {
    text: "A limitation period runs from the day the claim could first be brought.",
    anchors: [{ startAnchorId: "b2", endAnchorId: "b2" }],
  },
  abstract: "The court dismissed the appeal.",
  topics: ["promlčení"],
};

const submission = {
  fingerprint: FINGERPRINT,
  contentHash: CONTENT_HASH as string | null,
  model: "some-provider/some-model",
  ...OUTPUT,
};

describe("storing an analysis against the decision row", () => {
  let db: TestDatabase;
  let sourceId: SafeId<"caseLawSource">;
  let counter = 0;

  beforeAll(async () => {
    db = await getTestDb();
    const [source] = await db
      .insert(caseLawSources)
      .values({
        name: `analysis-writer-${Bun.randomUUIDv7().slice(0, 8)}`,
        adapterKey: ADAPTER_KEYS.CZ_NS,
      })
      .returning({ id: caseLawSources.id });
    if (!source) {
      throw new Error("expected a case-law source row");
    }
    sourceId = source.id;
  });

  afterAll(async () => {
    await releaseTestDb();
  });

  const insertDecision = async (
    analysis: PersistedDecisionAnalysis | null,
  ): Promise<SafeId<"caseLawDecision">> => {
    counter += 1;
    const [row] = await db
      .insert(caseLawDecisions)
      .values({
        sourceId,
        caseNumber: `21 Cdo ${String(counter)}/2026`,
        court: "Nejvyšší soud",
        country: "CZE",
        language: "cs",
        contentHash: CONTENT_HASH,
        analysis,
      })
      .returning({ id: caseLawDecisions.id });
    if (!row) {
      throw new Error("expected a decision row");
    }
    return row.id;
  };

  const storedFor = async (decisionId: SafeId<"caseLawDecision">) => {
    const [row] = await db
      .select({ analysis: caseLawDecisions.analysis })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decisionId))
      .limit(1);
    return parsePersistedDecisionAnalysis(row?.analysis);
  };

  const subjectFor = async (
    decisionId: SafeId<"caseLawDecision">,
  ): Promise<AnalysisSubject> => {
    const [row] = await db
      .select({
        analysis: caseLawDecisions.analysis,
        contentHash: caseLawDecisions.contentHash,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decisionId))
      .limit(1);
    if (!row) {
      throw new Error("expected a decision row");
    }
    return {
      analysis: row.analysis,
      contentHash: row.contentHash,
      source: { descriptor: null },
    };
  };

  const save = async (decisionId: SafeId<"caseLawDecision">) =>
    await applyAnalysisUpdate({
      decision: await subjectFor(decisionId),
      decisionId,
      input,
      now: NOW,
      store: createDbAnalysisStore(db),
      submission,
    });

  test("writes a version 3 analysis onto an empty row", async () => {
    const decisionId = await insertDecision(null);

    expect((await save(decisionId)).kind).toBe("saved");

    const stored = await storedFor(decisionId);
    expect(stored).not.toBeNull();
    if (stored === null || "status" in stored) {
      return;
    }
    expect(stored.version).toBe(3);
    expect(stored.inputFingerprint).toBe(FINGERPRINT);
    expect(stored.model).toBe("some-provider/some-model");
  });

  test("a second save of the same fingerprint changes nothing", async () => {
    const decisionId = await insertDecision(null);

    expect((await save(decisionId)).kind).toBe("saved");
    const first = await storedFor(decisionId);

    expect((await save(decisionId)).kind).toBe("unchanged");
    expect(await storedFor(decisionId)).toEqual(first);
  });

  test("a run holding the row is not overwritten", async () => {
    const sentinel = analysisSentinel(FINGERPRINT, NOW);
    const decisionId = await insertDecision(sentinel);

    expect((await save(decisionId)).kind).toBe("run-in-flight");
    expect(await storedFor(decisionId)).toEqual(sentinel);
  });

  test("a content hash the row no longer carries is refused", async () => {
    const decisionId = await insertDecision(null);
    await db
      .update(caseLawDecisions)
      .set({ contentHash: "d".repeat(64) })
      .where(eq(caseLawDecisions.id, decisionId));

    expect((await save(decisionId)).kind).toBe("stale-content-hash");
    expect(await storedFor(decisionId)).toBeNull();
  });

  test("a row that changed between the read and the claim is left alone", async () => {
    const decisionId = await insertDecision(null);
    const decision = await subjectFor(decisionId);
    // Another writer takes the row after this caller read it as empty.
    const other = analysisSentinel("0".repeat(64), NOW);
    await db
      .update(caseLawDecisions)
      .set({ analysis: other })
      .where(eq(caseLawDecisions.id, decisionId));

    const outcome = await applyAnalysisUpdate({
      decision,
      decisionId,
      input,
      now: NOW,
      store: createDbAnalysisStore(db),
      submission,
    });

    expect(outcome.kind).toBe("claim-lost");
    expect(await storedFor(decisionId)).toEqual(other);
  });
});
