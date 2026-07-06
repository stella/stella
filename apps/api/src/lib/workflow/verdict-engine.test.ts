import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { ScopedDb, Transaction } from "@/api/db";
import type { ResolvedTiers } from "@/api/handlers/playbooks/positions";
import { toSafeId } from "@/api/lib/branded-types";
import type { VerdictBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import {
  buildTierMatchUserMessage,
  computeVerdictBatch,
  gradeTierMatch,
  resolveMatchedRef,
} from "@/api/lib/workflow/verdict-engine";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

const tiers: ResolvedTiers = {
  ideal: "Governed by the laws of England and Wales.",
  fallbacks: [
    { rank: 0, label: "Common law", text: "Governed by the laws of Ireland." },
    { rank: 1, text: "Governed by the laws of Scotland." },
  ],
  acceptableRules: [
    { id: "ar-1", text: "A recognised common-law jurisdiction." },
    { id: "ar-2", text: "An English-language legal system." },
  ],
  notAcceptableRules: [
    { id: "nr-1", text: "A sanctioned jurisdiction." },
    { id: "nr-2", text: "A jurisdiction with no enforcement treaty." },
  ],
};

describe("buildTierMatchUserMessage — prompt assembly", () => {
  const message = buildTierMatchUserMessage({ tiers, askValue: "Delaware." });

  test("numbers the acceptable rules", () => {
    expect(message).toContain("1. A recognised common-law jurisdiction.");
    expect(message).toContain("2. An English-language legal system.");
  });

  test("includes the resolved ideal language", () => {
    expect(message).toContain("Governed by the laws of England and Wales.");
  });

  test("lists ranked fallbacks by their array rank, with labels", () => {
    expect(message).toContain(
      "[rank 0] (Common law) Governed by the laws of Ireland.",
    );
    expect(message).toContain("[rank 1] Governed by the laws of Scotland.");
  });

  test("lists the red-line rules by rank", () => {
    expect(message).toContain("[rank 0] A sanctioned jurisdiction.");
    expect(message).toContain(
      "[rank 1] A jurisdiction with no enforcement treaty.",
    );
  });

  test("appends the extracted value", () => {
    expect(message).toContain("Extracted value:\nDelaware.");
  });

  test("renders (none) for absent tiers", () => {
    const sparse = buildTierMatchUserMessage({
      tiers: { fallbacks: [], acceptableRules: [], notAcceptableRules: [] },
      askValue: "x",
    });
    expect(sparse).toContain("Ideal language:\n(none)");
  });
});

describe("resolveMatchedRef — rank → stable reference", () => {
  test("a fallback rank resolves to its label + text (no raw index)", () => {
    expect(resolveMatchedRef({ kind: "fallback", rank: 0 }, tiers)).toEqual({
      kind: "fallback",
      label: "Common law",
      text: "Governed by the laws of Ireland.",
    });
  });

  test("a labelless fallback omits the label", () => {
    expect(resolveMatchedRef({ kind: "fallback", rank: 1 }, tiers)).toEqual({
      kind: "fallback",
      text: "Governed by the laws of Scotland.",
    });
  });

  test("a red-line rank resolves to its ruleId + text", () => {
    expect(resolveMatchedRef({ kind: "redLine", rank: 1 }, tiers)).toEqual({
      kind: "redLine",
      ruleId: "nr-2",
      text: "A jurisdiction with no enforcement treaty.",
    });
  });

  test("an out-of-bounds rank drops the reference", () => {
    expect(
      resolveMatchedRef({ kind: "fallback", rank: 9 }, tiers),
    ).toBeUndefined();
    expect(
      resolveMatchedRef({ kind: "redLine", rank: 9 }, tiers),
    ).toBeUndefined();
  });

  test("an absent match resolves to no reference", () => {
    expect(resolveMatchedRef(undefined, tiers)).toBeUndefined();
  });
});

describe("computeVerdictBatch — pre-v2 verdict row without tiers", () => {
  test("grades to deviation without throwing and without an LLM call", async () => {
    const askPropertyId = toSafeId<"property">("ask_prop_1");
    const verdictPropertyId = toSafeId<"property">("verdict_prop_1");

    // Simulate a row materialized before the tiered-authoring migration: the
    // positions migration rewrote playbook_definitions.positions but never
    // properties.tool, so the persisted verdict tool carries `{standard}` and
    // has no `tiers` snapshot even though PlaybookVerdictTool types it present.
    const preV2VerdictProperty = asTestRaw<VerdictBatchProperty>({
      id: verdictPropertyId,
      status: "stale",
      content: { type: "single-select", version: 1, value: null },
      dependencies: [],
      tool: {
        version: 1,
        type: "playbook-verdict",
        askPropertyId,
        rule: { kind: "positionMatch" },
        severity: "medium",
        // tiers deliberately omitted: this is the pre-migration shape.
      },
    });

    // fetchInputFieldsForBatch runs `tx.select().from().where()`; return a
    // present ASK value so the positionMatch task reaches gradeTierMatch.
    const tx = {
      select: () => ({
        from: () => ({
          where: async () => [
            {
              id: toSafeId<"field">("field_1"),
              propertyId: askPropertyId,
              content: {
                type: "text",
                version: 1,
                value: "Some extracted clause value.",
              },
            },
          ],
        }),
      }),
    };
    const scopedDb: ScopedDb = async (run) =>
      await run(asTestRaw<Transaction>(tx));

    const result = await computeVerdictBatch({
      // A pre-aborted signal proves no external LLM call is attempted: the
      // empty-tiers guard returns before any AI/analytics setup.
      abortSignal: AbortSignal.abort(),
      organizationId: toSafeId<"organization">("org_1"),
      workspaceId: toSafeId<"workspace">("ws_1"),
      scopedDb,
      entityVersionId: toSafeId<"entityVersion">("ev_1"),
      verdictProperties: [preV2VerdictProperty],
      inputPropertyIds: [askPropertyId],
      orgAIConfig: null,
      promptCachingEnabled: false,
      serviceTier: "standard",
    });

    expect(result.erroredPropertyIds).toEqual([]);
    expect(result.aiResults).toHaveLength(1);
    const [verdict] = result.aiResults;
    expect(verdict?.propertyId).toBe(verdictPropertyId);
    expect(verdict?.content).toMatchObject({
      type: "single-select",
      value: "deviation",
    });

    const [justification] = result.aiJustifications;
    expect(justification?.content.blocks[0]).toMatchObject({
      kind: "playbook-verdict",
      rationale:
        "No acceptable, fallback, or red-line criteria were configured to compare against.",
    });
  });
});

describe("gradeTierMatch — empty-tier lifted row", () => {
  test("forces deviation without an LLM call when nothing is authored", async () => {
    const result = await gradeTierMatch({
      askValue: "A present but ungradeable value.",
      tiers: { fallbacks: [], acceptableRules: [], notAcceptableRules: [] },
      // A pre-aborted signal proves no external call is attempted: the guard
      // returns before any AI/analytics setup.
      abortSignal: AbortSignal.abort(),
      organizationId: toSafeId<"organization">("org_1"),
      workspaceId: toSafeId<"workspace">("ws_1"),
      entityVersionId: toSafeId<"entityVersion">("ev_1"),
      propertyId: toSafeId<"property">("prop_1"),
      orgAIConfig: null,
      promptCachingEnabled: false,
      serviceTier: "standard",
    });

    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) {
      expect(result.value.tier).toBe("deviation");
      expect(result.value.matchedRef).toBeUndefined();
    }
  });
});
