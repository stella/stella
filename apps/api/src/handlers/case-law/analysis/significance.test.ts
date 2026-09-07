/**
 * The graph fence. A significance statement is only as good as the
 * neighbourhood it was written about, so the fingerprint has to move when
 * that neighbourhood does, and stay put when nothing that reaches the
 * model has changed.
 */

import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import {
  graphFingerprintOf,
  significanceOutputSchema,
  significanceSystemPrompt,
  significanceUserMessage,
  SIGNIFICANCE_PROMPT_VERSION,
  type CitationGraphFacts,
} from "./significance";

const id = (last: string) =>
  toSafeId<"caseLawDecision">(`00000000-0000-0000-0000-0000000000${last}`);

const facts: CitationGraphFacts = {
  decisionId: id("01"),
  citedByCount: 3,
  treatmentCounts: {
    negative: 1,
    neutral: 0,
    positive: 2,
    supportive: 0,
    unclassified: 0,
  },
  countsByCourtTier: [
    { tier: 1, count: 2 },
    { tier: 2, count: 1 },
  ],
  laterNegativeCount: 1,
  reportedInCollection: true,
  citingDecisionIds: [id("02"), id("03"), id("04")],
};

describe("graphFingerprintOf", () => {
  test("is stable for the same neighbourhood", () => {
    expect(graphFingerprintOf(facts)).toBe(graphFingerprintOf({ ...facts }));
  });

  test("moves when a decision starts citing this one", () => {
    expect(
      graphFingerprintOf({
        ...facts,
        citingDecisionIds: [...facts.citingDecisionIds, id("05")],
      }),
    ).not.toBe(graphFingerprintOf(facts));
  });

  // The same citing decisions, reclassified: the ids did not move, but what
  // later courts made of the decision did.
  test("moves when a citation's treatment is reclassified", () => {
    expect(
      graphFingerprintOf({
        ...facts,
        treatmentCounts: { ...facts.treatmentCounts, negative: 0, neutral: 1 },
      }),
    ).not.toBe(graphFingerprintOf(facts));
  });

  test("moves when the decision becomes officially reported", () => {
    expect(
      graphFingerprintOf({ ...facts, reportedInCollection: false }),
    ).not.toBe(graphFingerprintOf(facts));
  });

  test("is a hex digest, so it can be compared as a plain string", () => {
    expect(graphFingerprintOf(facts)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("significance prompt", () => {
  test("shows the model the facts and nothing that is not in them", () => {
    const message = significanceUserMessage(facts);
    expect(message).toContain("Cited by: 3 decisions");
    expect(message).toContain("negative 1");
    expect(message).toContain("tier 1: 2");
    expect(message).toContain("Later decisions reading it negatively: 1");
    expect(message).toContain("Stated in an official reporter: yes");
    // No decision text, no case numbers, no court names: the layer is a
    // reading of the graph, and it may not smuggle in a reading of a text.
    expect(message).not.toContain("Rozsudek");
  });

  test("names the language the statement must be written in", () => {
    expect(significanceSystemPrompt("cs")).toContain('code "cs"');
  });

  test("accepts only the statement itself", () => {
    expect(significanceOutputSchema.entries.significance.expects).toBeDefined();
    expect(Object.keys(significanceOutputSchema.entries)).toEqual([
      "significance",
    ]);
  });

  test("carries a prompt version, because the graph fence cannot notice a prompt edit", () => {
    expect(SIGNIFICANCE_PROMPT_VERSION).toBeGreaterThanOrEqual(1);
  });
});
