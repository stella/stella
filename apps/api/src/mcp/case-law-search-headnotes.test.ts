import { describe, expect, test } from "bun:test";

import { APP_SEARCH_FIXTURE } from "@stll/api-contract/mcp-app.fixtures";

import {
  readDecisionHeadnote,
  readWholeDecisionHeadnote,
} from "../lib/case-law/decision-text";
import { LIMITS } from "../lib/limits";
import { boundCaseLawSearchHeadnotes } from "./case-law-search-headnotes";

const first = APP_SEARCH_FIXTURE.results.at(0);
if (first === undefined) {
  throw new Error("Missing search fixture");
}

describe("expanded case-law headnotes", () => {
  test("the expanded reading retains publisher text beyond the compact preview", () => {
    const text =
      "The court requires proof of causation and considers each claim. "
        .repeat(16)
        .trim();
    expect(text.length).toBeGreaterThan(LIMITS.caseLawHeadnoteMaxChars);
    const compact = readDecisionHeadnote({ headnote: text, keywords: null });
    const expanded = readDecisionHeadnote({
      headnote: text,
      keywords: null,
      maxChars: LIMITS.mcpCaseLawHeadnoteMaxChars,
    });
    expect(compact).toMatchObject({ type: "present", truncated: true });
    expect(expanded).toEqual({ type: "present", text, truncated: false });
    expect(readWholeDecisionHeadnote(text)).toEqual({ type: "present", text });
  });

  test.each([
    "A legal holding. ".repeat(600),
    'A "quoted" holding.\n'.repeat(600),
    "Právní věta o náhradě škody. ".repeat(600),
  ])(
    "twenty rows fit the structured-content budget with explicit cuts",
    (text) => {
      const page = {
        ...APP_SEARCH_FIXTURE,
        results: Array.from({ length: 20 }, (_, index) => ({
          ...first,
          decisionId: `decision-${index}`,
          snippet: "The court examines the right to compensation. ".repeat(9),
          headnote: { type: "present" as const, text, truncated: false },
        })),
      };
      expect(JSON.stringify(page).length).toBeGreaterThan(
        LIMITS.mcpCaseLawSearchPageMaxChars,
      );
      const result = boundCaseLawSearchHeadnotes(page);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(
        LIMITS.mcpCaseLawSearchPageMaxChars,
      );
      for (const row of result.results) {
        expect(row.headnote?.truncated).toBe(true);
        expect(row.headnote?.text.length).toBeLessThanOrEqual(
          LIMITS.mcpCaseLawHeadnoteMaxChars,
        );
        expect(row.headnote?.text.isWellFormed()).toBe(true);
        expect(row.appUrl).toBe(first.appUrl);
        expect(row.snippet).toBe(page.results.at(0)?.snippet);
      }
    },
  );

  test("short headnotes stay whole while longer rows share the remaining budget", () => {
    const page = {
      ...APP_SEARCH_FIXTURE,
      results: [
        { ...first, headnote: null },
        {
          ...first,
          headnote: {
            type: "present" as const,
            text: "Short holding.",
            truncated: false,
          },
        },
        {
          ...first,
          headnote: {
            type: "present" as const,
            text: "A longer holding. ".repeat(200),
            truncated: true,
          },
        },
      ],
    };
    const longHeadnote = { ...page.results.at(2)?.headnote };
    const result = boundCaseLawSearchHeadnotes(page);
    expect(result.results.at(0)?.headnote).toBeNull();
    expect(result.results.at(1)?.headnote).toEqual({
      type: "present",
      text: "Short holding.",
      truncated: false,
    });
    expect(result.results.at(2)?.headnote).toEqual(longHeadnote);
    expect(result.results.at(2)?.headnote?.truncated).toBe(true);
  });
});
