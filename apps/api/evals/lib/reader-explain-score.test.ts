import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import * as v from "valibot";

import {
  readerExplainCases,
  SCHREMS_I,
  SCHREMS_II,
} from "./reader-explain-cases";
import { resolveExplainCase, scoreExplainCase } from "./reader-explain-score";

const corpus = {
  decisions: [
    {
      decisionId: "source",
      ecli: SCHREMS_II,
      paragraphs: [
        {
          paragraphId: "selected",
          publisherParagraph: 57,
          text: "Selected public decision passage",
        },
      ],
    },
    {
      decisionId: "precedent",
      ecli: SCHREMS_I,
      paragraphs: [
        {
          paragraphId: "returned",
          publisherParagraph: 65,
          text: "Precedent excerpt",
        },
      ],
    },
  ],
  edges: [{ citingDecisionId: "source", citedDecisionId: "precedent" }],
};
const scenario = readerExplainCases.at(0);
if (!scenario) {
  throw new TypeError("Explain eval cases are empty");
}
const result = {
  caseId: scenario.id,
  harness: "local",
  answer: "Explanation grounded in the returned precedent.",
  citations: [{ decisionId: "precedent", paragraphId: "returned" }],
  toolReturnedCitations: [{ decisionId: "precedent", paragraphId: "returned" }],
};

describe("Explain local corpus evaluation", () => {
  test("ten unique cases cite paragraphs explicitly named in the recorded source decision", () => {
    expect(readerExplainCases).toHaveLength(10);
    expect(new Set(readerExplainCases.map(({ id }) => id)).size).toBe(10);
    expect(
      new Set(readerExplainCases.map(({ direction }) => direction)),
    ).toEqual(new Set(["cited", "citing"]));
    const fixture = v.parse(
      v.object({
        decisions: v.array(
          v.object({
            ecli: v.string(),
            document_ast: v.object({
              blocks: v.array(
                v.object({ anchorId: v.string(), plainText: v.string() }),
              ),
            }),
          }),
        ),
      }),
      JSON.parse(
        gunzipSync(
          readFileSync(
            new URL(
              "../../scripts/__fixtures__/case-law/eu-ecj.json.gz",
              import.meta.url,
            ),
          ),
        ).toString(),
      ),
    );
    const decision = fixture.decisions.find(({ ecli }) => ecli === SCHREMS_II);
    expect(decision).toBeDefined();
    if (!decision) {
      return;
    }
    for (const entry of readerExplainCases) {
      const source =
        entry.direction === "cited" ? entry.selection : entry.expectedCitation;
      const target =
        entry.direction === "cited" ? entry.expectedCitation : entry.selection;
      const paragraph = decision.document_ast.blocks.find(
        ({ anchorId }) =>
          anchorId === `point${String(source.publisherParagraph)}`,
      );
      expect(paragraph, entry.id).toBeDefined();
      expect(paragraph?.plainText, entry.id).toContain("C‑362/14");
      expect(paragraph?.plainText, entry.id).toMatch(
        new RegExp(
          `paragraphs? ${String(target.publisherParagraph)}(?:\\D|$)`,
          "u",
        ),
      );
    }
  });

  test("scores only citations actually returned by the local tool", () => {
    expect(
      scoreExplainCase({
        scenario,
        corpus,
        result,
        toolReturnedCitations: result.toolReturnedCitations,
      }).citationPass,
    ).toBe(true);
    expect(
      scoreExplainCase({ scenario, corpus, result, toolReturnedCitations: [] })
        .citationPass,
    ).toBe(false);
    expect(
      scoreExplainCase({
        scenario,
        corpus,
        result: {
          ...result,
          citations: [{ decisionId: "precedent", paragraphId: "invented" }],
        },
        toolReturnedCitations: result.toolReturnedCitations,
      }).citationPass,
    ).toBe(false);
    expect(
      scoreExplainCase({
        scenario,
        corpus,
        result,
        toolReturnedCitations: [
          { decisionId: "other", paragraphId: "returned" },
        ],
      }).citationPass,
    ).toBe(false);
    expect(
      scoreExplainCase({
        scenario,
        corpus,
        result: { ...result, caseId: "different" },
        toolReturnedCitations: result.toolReturnedCitations,
      }).citationPass,
    ).toBe(false);
    expect(
      scoreExplainCase({
        scenario,
        corpus,
        result,
        toolReturnedCitations: result.toolReturnedCitations,
      }).contentReview,
    ).toBe("required");
  });

  test("requires captured graph edges and actual corpus paragraph identities", () => {
    expect(() =>
      resolveExplainCase(scenario, { ...corpus, edges: [] }),
    ).toThrow("Missing captured cited edge");
    expect(() =>
      resolveExplainCase(scenario, { ...corpus, decisions: [] }),
    ).toThrow("Capture must contain exactly one decision");
    const first = corpus.decisions.at(0);
    if (!first) {
      throw new TypeError("Synthetic corpus is empty");
    }
    expect(() =>
      resolveExplainCase(scenario, {
        ...corpus,
        decisions: [...corpus.decisions, first],
      }),
    ).toThrow("Capture must contain exactly one decision");
  });
});
