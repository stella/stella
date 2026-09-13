import { describe, expect, test } from "bun:test";

import { createSafeId } from "@/api/lib/branded-types";
import {
  buildSuggestPromptUserMessage,
  sanitizeSuggestion,
} from "@/api/lib/properties/column-prompt-suggestion";
import type {
  SuggestPromptCaseLawFilters,
  SuggestPromptContext,
} from "@/api/lib/properties/column-prompt-suggestion";

const WORKSPACE_CONTEXT: SuggestPromptContext = {
  kind: "workspace",
  workspaceId: createSafeId<"workspace">(),
};

const NO_FILTERS: SuggestPromptCaseLawFilters = {
  court: undefined,
  decisionType: undefined,
  dateFrom: undefined,
  dateTo: undefined,
  language: undefined,
};

const caseLawContext = (
  overrides: Partial<Extract<SuggestPromptContext, { kind: "case-law" }>> = {},
): SuggestPromptContext => ({
  kind: "case-law",
  country: "CZ",
  query: "náhrada škody",
  filters: NO_FILTERS,
  samples: [],
  ...overrides,
});

describe("matter column prompts", () => {
  test("uses the column name's language for a new prompt", () => {
    const message = buildSuggestPromptUserMessage({
      name: "Odpovědnost jednatele",
      contentType: "text",
      options: undefined,
      currentPrompt: undefined,
      instruction: "Polish the writing.",
      context: WORKSPACE_CONTEXT,
    });

    expect(message).toContain(
      "Output language: Match the column name's language.",
    );
    expect(message).toContain("Write the extraction prompt:");
  });

  test("uses the current draft's language when refining a prompt", () => {
    const message = buildSuggestPromptUserMessage({
      name: "Executive liability",
      contentType: "text",
      options: undefined,
      currentPrompt: "Popište rozsah odpovědnosti jednatele.",
      instruction: "Make it concise.",
      context: WORKSPACE_CONTEXT,
    });

    expect(message).toContain(
      "Output language: Match the current draft's language.",
    );
    expect(message).toContain("Requested adjustment: Make it concise.");
  });

  test("carries no case-law framing", () => {
    const message = buildSuggestPromptUserMessage({
      name: "Governing law",
      contentType: "text",
      options: undefined,
      currentPrompt: undefined,
      instruction: "Polish the writing.",
      context: WORKSPACE_CONTEXT,
    });

    expect(message).not.toContain("Asked of: court decisions");
    expect(message).not.toContain("Current search:");
    expect(message).not.toContain("Decisions this search returned:");
  });
});

describe("question column prompts", () => {
  test("names the jurisdiction, the search and the answer kind", () => {
    const message = buildSuggestPromptUserMessage({
      name: "Byla žaloba zamítnuta?",
      contentType: "single-select",
      options: ["ano", "ne"],
      currentPrompt: undefined,
      instruction: "Make it concise.",
      context: caseLawContext(),
    });

    expect(message).toContain("country code CZ");
    expect(message).toContain("Current search: náhrada škody");
    expect(message).toContain("Result type: single-select");
    expect(message).toContain("Allowed options: ano, ne");
    expect(message).toContain("Write the question:");
  });

  test("names the filters the search is narrowed by", () => {
    const message = buildSuggestPromptUserMessage({
      name: "Which damages head was awarded?",
      contentType: "text",
      options: undefined,
      currentPrompt: undefined,
      instruction: "Polish the writing.",
      context: caseLawContext({
        filters: {
          court: "Nejvyšší soud",
          decisionType: "rozsudek",
          dateFrom: "2020-01-01",
          dateTo: "2024-12-31",
          language: "cs",
        },
      }),
    });

    expect(message).toContain("court Nejvyšší soud");
    expect(message).toContain("decision type rozsudek");
    expect(message).toContain("decided on or after 2020-01-01");
    expect(message).toContain("decided on or before 2024-12-31");
    expect(message).toContain("language cs");
  });

  test("grounds the wording in the sampled headnotes", () => {
    const message = buildSuggestPromptUserMessage({
      name: "Which damages head was awarded?",
      contentType: "text",
      options: undefined,
      currentPrompt: undefined,
      instruction: "Polish the writing.",
      context: caseLawContext({
        samples: [
          {
            caseNumber: "25 Cdo 1234/2021",
            court: "Nejvyšší soud",
            decisionDate: "2022-03-14",
            headnote: "Ušlý zisk se nahrazuje jen v prokázaném rozsahu.",
          },
          {
            caseNumber: "30 Cdo 99/2020",
            court: "Nejvyšší soud",
            decisionDate: null,
            headnote: null,
          },
        ],
      }),
    });

    expect(message).toContain("Decisions this search returned:");
    expect(message).toContain(
      "- 25 Cdo 1234/2021, Nejvyšší soud, 2022-03-14: Ušlý zisk se nahrazuje jen v prokázaném rozsahu.",
    );
    // A row whose publisher summary is withheld still names the decision and
    // quotes nothing.
    expect(message).toContain("- 30 Cdo 99/2020, Nejvyšší soud");
    expect(message).not.toContain("30 Cdo 99/2020, Nejvyšší soud:");
  });

  test("omits the jurisdiction and the search a mixed listing has neither of", () => {
    const message = buildSuggestPromptUserMessage({
      name: "Which damages head was awarded?",
      contentType: "text",
      options: undefined,
      currentPrompt: undefined,
      instruction: "Polish the writing.",
      context: caseLawContext({ country: undefined, query: undefined }),
    });

    expect(message).toContain("Asked of: court decisions.");
    expect(message).not.toContain("country code");
    expect(message).not.toContain("Current search:");
  });
});

describe("suggestion sanitizing", () => {
  test("collapses a multi-line answer onto one line and drops wrapping quotes", () => {
    expect(sanitizeSuggestion('  "Extract the\n  governing law."  ')).toBe(
      "Extract the governing law.",
    );
  });

  test("caps the suggestion at the composer's single-line budget", () => {
    const sanitized = sanitizeSuggestion("a".repeat(400));

    expect(sanitized).toHaveLength(280);
    expect(sanitized.endsWith("…")).toBe(true);
  });
});
