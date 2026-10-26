import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { CASE_LAW_RESEARCH_SUGGEST_SAMPLES_MAX } from "@stll/api-contract";

import { suggestResearchColumnPromptBodySchema } from "@/api/handlers/case-law/research/schema";

const decisionIds = (count: number) =>
  Array.from({ length: count }, () => Bun.randomUUIDv7());

const body = (overrides: Record<string, unknown> = {}) => ({
  question: "Byla žaloba zamítnuta?",
  answerKind: "text",
  instruction: "Make it concise.",
  country: "CZ",
  query: "náhrada škody",
  filters: {},
  decisionIds: decisionIds(CASE_LAW_RESEARCH_SUGGEST_SAMPLES_MAX),
  ...overrides,
});

describe("question prompt suggestion body", () => {
  test("accepts the full sample allowance", () => {
    expect(v.is(suggestResearchColumnPromptBodySchema, body())).toBe(true);
  });

  test("rejects more decisions than the sample allowance", () => {
    expect(
      v.is(
        suggestResearchColumnPromptBodySchema,
        body({
          decisionIds: decisionIds(CASE_LAW_RESEARCH_SUGGEST_SAMPLES_MAX + 1),
        }),
      ),
    ).toBe(false);
  });

  test("refuses a suggestion with no question to refine", () => {
    expect(
      v.is(suggestResearchColumnPromptBodySchema, body({ question: "" })),
    ).toBe(false);
  });

  /**
   * The client names decisions; it never sends their text. Pinning the accepted
   * keys is what stops a headnote, a passage or a whole decision body being
   * added to the body later: the grounding is read on the server, through the
   * public gate, or it is not read at all.
   */
  test("accepts only the search context, never decision text", () => {
    expect(
      Object.keys(suggestResearchColumnPromptBodySchema.entries).toSorted(),
    ).toEqual([
      "answerKind",
      "country",
      "decisionIds",
      "filters",
      "instruction",
      "options",
      "query",
      "question",
    ]);
    expect(
      v.is(
        suggestResearchColumnPromptBodySchema,
        body({ samples: [{ headnote: "leaked" }] }),
      ),
    ).toBe(false);
  });
});
