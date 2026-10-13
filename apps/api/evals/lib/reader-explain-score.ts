import { panic } from "better-result";
import * as v from "valibot";

import type { ExplainEvalCase } from "./reader-explain-cases";

const citationSchema = v.object({
  decisionId: v.string(),
  paragraphId: v.string(),
});

export const explainCorpusCaptureSchema = v.object({
  decisions: v.array(
    v.object({
      decisionId: v.string(),
      ecli: v.string(),
      paragraphs: v.array(
        v.object({
          paragraphId: v.string(),
          publisherParagraph: v.number(),
          text: v.pipe(v.string(), v.minLength(1)),
        }),
      ),
    }),
  ),
  edges: v.array(
    v.object({ citingDecisionId: v.string(), citedDecisionId: v.string() }),
  ),
});

export const explainLocalResultSchema = v.object({
  runId: v.pipe(v.string(), v.uuid()),
  caseId: v.string(),
  harness: v.pipe(v.string(), v.minLength(1)),
  answer: v.pipe(v.string(), v.minLength(1)),
  citations: v.array(citationSchema),
});

type CorpusCapture = v.InferOutput<typeof explainCorpusCaptureSchema>;
type ExplainLocalResult = v.InferOutput<typeof explainLocalResultSchema>;

export const explainToolTraceSchema = v.object({
  runId: v.pipe(v.string(), v.uuid()),
  caseId: v.string(),
  citations: v.array(citationSchema),
});

const MAX_EXCERPTS = 8;
const MAX_CONTEXT_PARAGRAPHS = 16;

export const resolveExplainCase = (
  scenario: ExplainEvalCase,
  corpus: CorpusCapture,
) => {
  const findParagraph = ({
    ecli,
    publisherParagraph,
  }: ExplainEvalCase["selection"]) => {
    const matches = corpus.decisions.filter((entry) => entry.ecli === ecli);
    if (matches.length !== 1) {
      return panic(`Capture must contain exactly one decision for ${ecli}`);
    }
    const decision = matches.at(0);
    if (!decision) {
      return panic(`Missing corpus capture for ${ecli}`);
    }
    const paragraphs = decision.paragraphs.filter(
      (entry) => entry.publisherParagraph === publisherParagraph,
    );
    if (paragraphs.length !== 1) {
      return panic(
        `Capture must resolve ${ecli} paragraph ${String(publisherParagraph)} uniquely`,
      );
    }
    const paragraph = paragraphs.at(0);
    if (!paragraph) {
      return panic(`Missing captured paragraph for ${ecli}`);
    }
    return { decisionId: decision.decisionId, ...paragraph };
  };
  const selection = findParagraph(scenario.selection);
  const expected = findParagraph(scenario.expectedCitation);
  const edgeExists = corpus.edges.some(
    ({ citingDecisionId, citedDecisionId }) =>
      scenario.direction === "cited"
        ? citingDecisionId === selection.decisionId &&
          citedDecisionId === expected.decisionId
        : citedDecisionId === selection.decisionId &&
          citingDecisionId === expected.decisionId,
  );
  if (!edgeExists) {
    return panic(
      `Missing captured ${scenario.direction} edge for ${scenario.id}`,
    );
  }
  const adjacentDecisions = corpus.edges.flatMap(
    ({ citingDecisionId, citedDecisionId }) => {
      if (
        citingDecisionId !== selection.decisionId &&
        citedDecisionId !== selection.decisionId
      ) {
        return [];
      }
      return [
        {
          decisionId:
            citingDecisionId === selection.decisionId
              ? citedDecisionId
              : citingDecisionId,
          direction:
            citingDecisionId === selection.decisionId
              ? ("cited" as const)
              : ("citing" as const),
        },
      ];
    },
  );
  const excerpts = adjacentDecisions
    .flatMap(({ decisionId, direction }) =>
      corpus.decisions
        .filter((decision) => decision.decisionId === decisionId)
        .flatMap(({ ecli, paragraphs }) =>
          paragraphs.map((paragraph) => ({
            decisionId,
            direction,
            ecli,
            ...paragraph,
          })),
        ),
    )
    .toSorted(
      (left, right) =>
        Number(right.direction === scenario.direction) -
          Number(left.direction === scenario.direction) ||
        Number(
          right.decisionId === expected.decisionId &&
            right.paragraphId === expected.paragraphId,
        ) -
          Number(
            left.decisionId === expected.decisionId &&
              left.paragraphId === expected.paragraphId,
          ),
    )
    .slice(0, MAX_EXCERPTS);
  const contextParagraphs = corpus.decisions
    .filter(({ decisionId }) => decisionId === selection.decisionId)
    .flatMap(({ decisionId, paragraphs }) =>
      paragraphs.map((paragraph) => ({ decisionId, ...paragraph })),
    );
  const selectionIndex = contextParagraphs.findIndex(
    ({ paragraphId, publisherParagraph }) =>
      paragraphId === selection.paragraphId &&
      publisherParagraph === selection.publisherParagraph,
  );
  if (selectionIndex === -1) {
    return panic(
      `Selected paragraph is missing from context for ${scenario.id}`,
    );
  }
  const contextStart = Math.max(
    0,
    Math.min(
      selectionIndex - Math.floor(MAX_CONTEXT_PARAGRAPHS / 2),
      contextParagraphs.length - MAX_CONTEXT_PARAGRAPHS,
    ),
  );
  const context = contextParagraphs.slice(
    contextStart,
    contextStart + MAX_CONTEXT_PARAGRAPHS,
  );
  return { selection, expected, excerpts, context };
};

type ScoreExplainCaseOptions = {
  scenario: ExplainEvalCase;
  corpus: CorpusCapture;
  result: ExplainLocalResult;
  toolTraces: v.InferOutput<typeof explainToolTraceSchema>[];
};

export const scoreExplainCase = ({
  scenario,
  corpus,
  result,
  toolTraces,
}: ScoreExplainCaseOptions) => {
  const resolved = resolveExplainCase(scenario, corpus);
  const toolReturnedCitations = toolTraces
    .filter(
      ({ caseId, runId }) => caseId === scenario.id && runId === result.runId,
    )
    .flatMap(({ citations }) => citations);
  const sameCitation = (
    left: v.InferOutput<typeof citationSchema>,
    right: v.InferOutput<typeof citationSchema>,
  ) =>
    left.decisionId === right.decisionId &&
    left.paragraphId === right.paragraphId;
  const permitted = [
    resolved.selection,
    ...resolved.context,
    ...resolved.excerpts,
  ];
  const invalidCitations = result.citations.filter(
    (citation) => !permitted.some((entry) => sameCitation(citation, entry)),
  );
  const unreturnedCitations = result.citations.filter(
    (citation) =>
      citation.decisionId !== resolved.selection.decisionId &&
      !toolReturnedCitations.some((entry) => sameCitation(citation, entry)),
  );
  const invalidToolResults = toolReturnedCitations.filter(
    (citation) =>
      !resolved.excerpts.some((entry) => sameCitation(citation, entry)),
  );
  const expectedCited = result.citations.some((citation) =>
    sameCitation(citation, resolved.expected),
  );
  return {
    caseId: scenario.id,
    citationPass:
      result.caseId === scenario.id &&
      expectedCited &&
      invalidCitations.length === 0 &&
      unreturnedCitations.length === 0 &&
      invalidToolResults.length === 0,
    expectedCited,
    invalidCitations,
    unreturnedCitations,
    invalidToolResults,
    expectedInsight: scenario.expectedInsight,
    answer: result.answer,
    contentReview: "required" as const,
  };
};
