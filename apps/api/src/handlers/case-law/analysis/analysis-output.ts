/**
 * The one shape a document analysis of a court decision is produced in,
 * whoever produced it: the in-app generation run constrains its model with
 * this schema, `src/scripts/decision-analysis-input.ts` publishes it so an
 * external producer can constrain its own model with the same one, and
 * `src/scripts/decision-analysis-save.ts` parses what comes back through
 * it. A second spelling of this shape
 * anywhere would let the three drift, so there is exactly one.
 *
 * Document-fenced layers only. `significance` is written from the citation
 * graph, not from the document, and is deliberately absent here: the
 * schema is strict, so a submission carrying it is rejected rather than
 * quietly stripped.
 */

import type { JsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";

import type {
  AnalysisCitedSpan,
  AnalysisHeading,
  DecisionAnalysisV4,
} from "@stll/legal-ast/analysis";
import {
  analysisAbstractSpansSchema,
  analysisHeadingInputSchema,
  analysisHoldingSpansSchema,
  analysisTopicsSchema,
  citedPassageCitationCount,
  CURRENT_ANALYSIS_VERSION,
} from "@stll/legal-ast/analysis";

import { reportCaseLawIncompleteAnswer } from "@/api/lib/case-law/incomplete-answer-telemetry";
import { toJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";

import { normalizeAnalysisHeadingLabels } from "./category-catalog";

/**
 * What the model returns and what a caller submits. Nesting is Stella's to
 * build, so a heading's `children` is absent; ids the model invented are
 * replaced, so `id` is accepted but never trusted; the language is
 * stamped on from the decision, so no layer carries one.
 */
export const analysisOutputSchema = v.strictObject({
  headings: v.array(analysisHeadingInputSchema),
  holding: analysisHoldingSpansSchema,
  abstract: analysisAbstractSpansSchema,
  topics: analysisTopicsSchema,
});

export type AnalysisOutput = v.InferOutput<typeof analysisOutputSchema>;

/**
 * The same schema as JSON Schema, for a producer that constrains its own
 * model. Computed once: a pure projection of a module-level schema.
 * `errorMode: "throw"` so a schema this converter cannot express fails at
 * load rather than shipping a silently lossy contract to an agent.
 */
export const ANALYSIS_OUTPUT_JSON_SCHEMA: JsonSchema = toJsonSchema(
  analysisOutputSchema,
  { errorMode: "throw" },
);

type BuildAnalysisOptions = {
  output: AnalysisOutput;
  /** The decision's language: what every layer is written in. */
  language: string;
  /** The model id, as its producer names it. */
  model: string;
  inputFingerprint: string;
  generatedAt: Date;
  /**
   * Every anchor id the parse the analysis was computed over carries, in
   * reading order. Every cited span's anchors are checked against it.
   */
  anchorIds: readonly string[];
};

/**
 * A passage's spans, each citing only the ranges that name real paragraphs
 * of this parse. The text is kept whole: a dropped citation loses a link,
 * never a word of the passage.
 *
 * A producer can return an id that does not exist, or a range that runs
 * backwards. Persisting one gives the reader a button that scrolls nowhere,
 * and no amount of care at the call site prevents it: the check belongs
 * here, where the parse is known, so a dead citation is unrepresentable
 * rather than merely unlikely.
 */
const usableSpans = (
  spans: readonly AnalysisCitedSpan[],
  positions: ReadonlyMap<string, number>,
): AnalysisCitedSpan[] => {
  const usable = spans.map((span) => ({
    text: span.text,
    anchors: span.anchors.filter((anchor) => {
      const start = positions.get(anchor.startAnchorId);
      const end = positions.get(anchor.endAnchorId);
      return start !== undefined && end !== undefined && start <= end;
    }),
  }));
  reportCaseLawIncompleteAnswer({
    surface: "analysis",
    reason: "invalid_output",
    count: citedPassageCitationCount(spans) - citedPassageCitationCount(usable),
  });
  return usable;
};

/**
 * Stable ids are assigned here, not by whoever produced the output: an id
 * the model invented is not stable across runs, and the reader's
 * highlight state is keyed by it.
 */
const createAnalysisHeading = ({
  heading,
  language,
}: {
  heading: AnalysisOutput["headings"][number];
  language: string;
}): AnalysisHeading =>
  normalizeAnalysisHeadingLabels({
    heading: {
      id: Bun.randomUUIDv7(),
      label: heading.label,
      category: heading.category,
      startAnchorId: heading.startAnchorId,
      endAnchorId: heading.endAnchorId,
      annotations: heading.annotations.map((annotation) => ({
        id: Bun.randomUUIDv7(),
        summary: annotation.summary,
        startAnchorId: annotation.startAnchorId,
        endAnchorId: annotation.endAnchorId,
        textSnippet: annotation.textSnippet,
      })),
      children: [],
    },
    language,
  });

export const buildPartialAnalysisTree = ({
  headings,
  language,
}: {
  headings: AnalysisOutput["headings"];
  language: string;
}): DecisionAnalysisV4["tree"] =>
  headings.map((heading) => createAnalysisHeading({ heading, language }));

/**
 * The persisted analysis for one parsed output. Provenance (`model`,
 * `generatedAt`, `inputFingerprint` — which digests the system prompt, so
 * it is the prompt's version too) is stamped here rather than accepted
 * from the producer, so no caller can claim a run it did not make.
 */
export const buildDecisionAnalysis = ({
  anchorIds,
  generatedAt,
  inputFingerprint,
  language,
  model,
  output,
}: BuildAnalysisOptions): DecisionAnalysisV4 => {
  const positions = new Map(anchorIds.map((id, index) => [id, index]));
  return {
    version: CURRENT_ANALYSIS_VERSION,
    generatedAt: generatedAt.toISOString(),
    model,
    inputFingerprint,
    tree: buildPartialAnalysisTree({ headings: output.headings, language }),
    holding: { spans: usableSpans(output.holding, positions), language },
    abstract: { spans: usableSpans(output.abstract, positions), language },
    topics: output.topics,
  };
};
