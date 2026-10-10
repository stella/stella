import { describe, expect, test } from "bun:test";

import {
  buildReaderAnswerPrompt,
  READER_ANSWER_CONTEXT_CHARS,
  validateReaderAnswerCitations,
} from "@/api/handlers/legal-reader/answers/prompt";
import { toSafeId } from "@/api/lib/branded-types";

const decisionId = toSafeId<"caseLawDecision">(
  "11111111-1111-4111-8111-111111111111",
);
const relatedId = toSafeId<"caseLawDecision">(
  "22222222-2222-4222-8222-222222222222",
);
const anchor = {
  paragraphId: "p-2",
  quote: "selected passage",
  startOffset: 0,
  endOffset: 16,
};

describe("reader answer evidence", () => {
  test("uses the caller locale and the selected passage's decision context", () => {
    const prompt = buildReaderAnswerPrompt({
      decision: {
        decisionId,
        paragraphs: [
          { paragraphId: "p-1", text: "The facts" },
          { paragraphId: "p-2", text: "selected passage" },
          { paragraphId: "p-3", text: "The holding" },
        ],
      },
      anchor,
      locale: "cs-CZ",
    });
    expect(prompt.system).toContain("Respond in locale cs-CZ");
    expect(JSON.parse(prompt.context)).toEqual({
      decisionId,
      selection: anchor,
      paragraphs: [
        { paragraphId: "p-1", text: "The facts" },
        { paragraphId: "p-2", text: "selected passage" },
        { paragraphId: "p-3", text: "The holding" },
      ],
    });
    expect(prompt.citations).toEqual(
      ["p-1", "p-2", "p-3"].map((paragraphId) => ({ decisionId, paragraphId })),
    );
  });

  test("prioritizes the selected paragraph when the decision exceeds the context bound", () => {
    const prompt = buildReaderAnswerPrompt({
      decision: {
        decisionId,
        paragraphs: [
          { paragraphId: "p-1", text: "a".repeat(READER_ANSWER_CONTEXT_CHARS) },
          { paragraphId: "p-2", text: anchor.quote },
          { paragraphId: "p-3", text: "The holding" },
        ],
      },
      anchor,
      locale: "en-GB",
    });
    expect(prompt.context).toContain(anchor.quote);
    expect(prompt.citations).toEqual([
      { decisionId, paragraphId: "p-2" },
      { decisionId, paragraphId: "p-3" },
    ]);
    expect(prompt.context).not.toContain("a".repeat(100));
  });

  test("an oversized selected paragraph remains evidence around the actual selection", () => {
    const prefix = "Background ".repeat(4000);
    const selectedAnchor = {
      ...anchor,
      startOffset: prefix.length,
      endOffset: prefix.length + anchor.quote.length,
    };
    const prompt = buildReaderAnswerPrompt({
      decision: {
        decisionId,
        paragraphs: [
          {
            paragraphId: anchor.paragraphId,
            text: `${prefix}${anchor.quote}${"Further context ".repeat(4000)}`,
          },
        ],
      },
      anchor: selectedAnchor,
      locale: "cs-CZ",
    });
    expect(prompt.citations).toEqual([
      { decisionId, paragraphId: anchor.paragraphId },
    ]);
    expect(JSON.parse(prompt.context)).toMatchObject({
      paragraphs: [
        {
          paragraphId: anchor.paragraphId,
          text: expect.stringContaining(anchor.quote),
        },
      ],
    });
    expect(prompt.context.length).toBeLessThan(
      READER_ANSWER_CONTEXT_CHARS + 1000,
    );
  });

  test("keeps only supplied paragraph identities and deduplicates their chips", () => {
    const own = { decisionId, paragraphId: "p-2" };
    const related = { decisionId: relatedId, paragraphId: "p-1" };
    const original = `Holding [[${decisionId}#p-2]]. Related [[${relatedId}#p-1]]. Again [[${decisionId}#p-2]]. Invented [[${decisionId}#p-99]].`;
    const result = validateReaderAnswerCitations({
      content: original,
      allowed: [own, related],
    });
    expect(result.citations).toEqual([own, related]);
    expect(result.invalidCitationCount).toBe(1);
    expect(result.content).toContain(`[[${relatedId}#p-1]]`);
    expect(result.content).not.toContain("p-99");
  });

  test("a paragraph identity from another decision needs its own evidence", () => {
    const content = `Related [[${relatedId}#p-2]].`;
    const before = validateReaderAnswerCitations({
      content,
      allowed: [{ decisionId, paragraphId: "p-2" }],
    });
    expect(before).toEqual({
      content: "Related .",
      citations: [],
      invalidCitationCount: 1,
    });
    const after = validateReaderAnswerCitations({
      content,
      allowed: [{ decisionId: relatedId, paragraphId: "p-2" }],
    });
    expect(after).toEqual({
      content,
      citations: [{ decisionId: relatedId, paragraphId: "p-2" }],
      invalidCitationCount: 0,
    });
  });
  test("malformed markers remain literal while complete markers retain their provenance", () => {
    const citation = { decisionId, paragraphId: "p-2" };
    const marker = `[[${decisionId}#p-2]]`;
    const malformed = "[[]] [[unfinished\n[[single] text ";
    const result = validateReaderAnswerCitations({
      content: `${malformed}${marker} [[[invented]] ${marker}`,
      allowed: [citation],
    });
    expect(result).toEqual({
      content: `${malformed}${marker}  ${marker}`,
      citations: [citation],
      invalidCitationCount: 1,
    });
  });
});
