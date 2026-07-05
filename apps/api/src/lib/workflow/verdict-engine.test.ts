import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import type { ResolvedTiers } from "@/api/handlers/playbooks/positions";
import { toSafeId } from "@/api/lib/branded-types";
import {
  buildTierMatchUserMessage,
  gradeTierMatch,
  resolveMatchedRef,
} from "@/api/lib/workflow/verdict-engine";

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
