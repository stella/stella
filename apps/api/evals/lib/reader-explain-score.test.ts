import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import * as v from "valibot";

import {
  readerExplainCases,
  SCHREMS_I,
  SCHREMS_II,
} from "./reader-explain-cases";
import type { ExplainEvalCase } from "./reader-explain-cases";
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
  runId: "11111111-1111-4111-8111-111111111111",
  caseId: scenario.id,
  harness: "local",
  answer: "Explanation grounded in the returned precedent.",
  citations: [{ decisionId: "precedent", paragraphId: "returned" }],
};

const trace = {
  runId: result.runId,
  caseId: scenario.id,
  citations: result.citations,
};

describe("Explain local corpus evaluation", () => {
  test.each([
    { selectedParagraph: 1, firstParagraph: 1, lastParagraph: 16 },
    { selectedParagraph: 2, firstParagraph: 1, lastParagraph: 16 },
    { selectedParagraph: 187, firstParagraph: 179, lastParagraph: 194 },
    { selectedParagraph: 199, firstParagraph: 185, lastParagraph: 200 },
    { selectedParagraph: 200, firstParagraph: 185, lastParagraph: 200 },
  ])(
    "centers or clamps context around publisher paragraph $selectedParagraph",
    ({ selectedParagraph, firstParagraph, lastParagraph }) => {
      const capturedCorpus = {
        ...corpus,
        decisions: [
          {
            decisionId: "source",
            ecli: SCHREMS_II,
            paragraphs: Array.from({ length: 200 }, (_, index) => ({
              paragraphId: `captured-${String(index + 1)}`,
              publisherParagraph: index + 1,
              text: `Captured passage ${String(index + 1)}`,
            })),
          },
          ...corpus.decisions.filter(
            ({ decisionId }) => decisionId !== "source",
          ),
        ],
      } satisfies Parameters<typeof resolveExplainCase>[1];
      const { selection, context } = resolveExplainCase(
        {
          ...scenario,
          selection: {
            ecli: SCHREMS_II,
            publisherParagraph: selectedParagraph,
          },
        },
        capturedCorpus,
      );
      expect(context).toHaveLength(16);
      expect(context).toContainEqual(selection);
      expect(context.at(0)?.publisherParagraph).toBe(firstParagraph);
      expect(context.at(-1)?.publisherParagraph).toBe(lastParagraph);
    },
  );

  test("every selection retains a bounded contiguous window in capture order", () => {
    for (const length of [1, 8, 16, 17, 200]) {
      const paragraphs = Array.from({ length }, (_, index) => ({
        paragraphId: `captured-${String(index)}`,
        // Deliberately reverse publisher numbering so sorting cannot replace capture order.
        publisherParagraph: length - index,
        text: `Captured passage ${String(index)}`,
      }));
      const capturedCorpus = {
        ...corpus,
        decisions: [
          { decisionId: "source", ecli: SCHREMS_II, paragraphs },
          ...corpus.decisions.filter(
            ({ decisionId }) => decisionId !== "source",
          ),
        ],
      } satisfies Parameters<typeof resolveExplainCase>[1];
      for (const paragraph of paragraphs) {
        const { selection, context } = resolveExplainCase(
          {
            ...scenario,
            selection: {
              ecli: SCHREMS_II,
              publisherParagraph: paragraph.publisherParagraph,
            },
          },
          capturedCorpus,
        );
        expect(context).toHaveLength(Math.min(length, 16));
        expect(context).toContainEqual(selection);
        const firstIndex = paragraphs.findIndex(
          ({ paragraphId }) => paragraphId === context.at(0)?.paragraphId,
        );
        expect(firstIndex).toBeGreaterThanOrEqual(0);
        expect(context).toEqual(
          paragraphs
            .slice(firstIndex, firstIndex + context.length)
            .map((entry) => ({ decisionId: "source", ...entry })),
        );
      }
    }
  });

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
        toolTraces: [trace],
      }).citationPass,
    ).toBe(true);
    expect(
      scoreExplainCase({ scenario, corpus, result, toolTraces: [] })
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
        toolTraces: [trace],
      }).citationPass,
    ).toBe(false);
    expect(
      scoreExplainCase({
        scenario,
        corpus,
        result,
        toolTraces: [
          {
            ...trace,
            citations: [{ decisionId: "other", paragraphId: "returned" }],
          },
        ],
      }).citationPass,
    ).toBe(false);
    expect(
      scoreExplainCase({
        scenario,
        corpus,
        result: { ...result, caseId: "different" },
        toolTraces: [trace],
      }).citationPass,
    ).toBe(false);
    expect(
      scoreExplainCase({
        scenario,
        corpus,
        result,
        toolTraces: [trace],
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

  test.each(["cited", "citing"] as const)(
    "keeps the expected paragraph and %s direction ahead of competing excerpts",
    (direction) => {
      const expectedDecision = corpus.decisions.find(
        ({ decisionId }) => decisionId === "precedent",
      );
      expect(expectedDecision).toBeDefined();
      if (!expectedDecision) {
        throw new TypeError("Synthetic precedent is missing");
      }
      const competingParagraphs = Array.from({ length: 12 }, (_, index) => ({
        paragraphId: `competing-${String(index)}`,
        publisherParagraph: 200 + index,
        text: "Competing related passage",
      }));
      expect(competingParagraphs.length).toBeGreaterThan(8);
      const targetScenario = {
        ...scenario,
        direction,
      } satisfies ExplainEvalCase;
      const crowdedCorpus = {
        decisions: [
          ...corpus.decisions.filter(
            ({ decisionId }) => decisionId !== "precedent",
          ),
          {
            decisionId: "opposite",
            ecli: "ECLI:EU:C:2021:1",
            paragraphs: competingParagraphs,
          },
          {
            ...expectedDecision,
            paragraphs: [
              ...competingParagraphs,
              ...expectedDecision.paragraphs,
            ],
          },
        ],
        edges:
          direction === "cited"
            ? [
                { citingDecisionId: "opposite", citedDecisionId: "source" },
                { citingDecisionId: "source", citedDecisionId: "precedent" },
              ]
            : [
                { citingDecisionId: "source", citedDecisionId: "opposite" },
                { citingDecisionId: "precedent", citedDecisionId: "source" },
              ],
      };
      const { excerpts } = resolveExplainCase(targetScenario, crowdedCorpus);
      expect(excerpts).toHaveLength(8);
      expect(excerpts.every((excerpt) => excerpt.direction === direction)).toBe(
        true,
      );
      expect(excerpts.at(0)).toMatchObject({
        decisionId: "precedent",
        paragraphId: "returned",
        direction,
      });
      expect(
        scoreExplainCase({
          scenario: targetScenario,
          corpus: crowdedCorpus,
          result,
          toolTraces: [{ ...trace, citations: excerpts }],
        }).citationPass,
      ).toBe(true);
    },
  );

  test("a previous run's tool trace cannot satisfy a new run's citation", () => {
    const newResult = {
      ...result,
      runId: "22222222-2222-4222-8222-222222222222",
    };
    expect(newResult.runId).not.toBe(trace.runId);
    const staleScore = scoreExplainCase({
      scenario,
      corpus,
      result: newResult,
      toolTraces: [trace],
    });
    expect(staleScore.citationPass).toBe(false);
    expect(staleScore.unreturnedCitations).toEqual(result.citations);
    expect(
      scoreExplainCase({
        scenario,
        corpus,
        result: newResult,
        toolTraces: [trace, { ...trace, runId: newResult.runId }],
      }).citationPass,
    ).toBe(true);
  });
});
