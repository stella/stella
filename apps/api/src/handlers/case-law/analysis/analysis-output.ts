/**
 * The one shape a document analysis of a court decision is produced in,
 * whoever produced it: the in-app generation run constrains its model with
 * this schema, `analysis.input.get` publishes it so an external producer
 * can constrain its own model with the same one, and `analysis.update`
 * parses what comes back through it. A second spelling of this shape
 * anywhere would let the three drift, so there is exactly one.
 *
 * Document-fenced layers only. `significance` is written from the citation
 * graph, not from the document, and is deliberately absent here: the
 * schema is strict, so a submission carrying it is rejected rather than
 * quietly stripped.
 */

import { toJsonSchema } from "@valibot/to-json-schema";
import type { JsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";

import type {
  AnalysisHeading,
  DecisionAnalysisV3,
} from "@stll/legal-ast/analysis";
import {
  analysisAbstractTextSchema,
  analysisHeadingInputSchema,
  analysisHoldingInputSchema,
  analysisTopicsSchema,
  CURRENT_ANALYSIS_VERSION,
} from "@stll/legal-ast/analysis";

import { normalizeAnalysisHeadingLabels } from "./category-catalog";

/**
 * What the model returns and what a caller submits. Nesting is Stella's to
 * build, so a heading's `children` is absent; ids the model invented are
 * replaced, so `id` is accepted but never trusted; the language is
 * stamped on from the decision, so no layer carries one.
 */
export const analysisOutputSchema = v.strictObject({
  headings: v.array(analysisHeadingInputSchema),
  holding: analysisHoldingInputSchema,
  abstract: analysisAbstractTextSchema,
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

/**
 * The persisted analysis for one parsed output. Provenance (`model`,
 * `generatedAt`, `inputFingerprint` — which digests the system prompt, so
 * it is the prompt's version too) is stamped here rather than accepted
 * from the producer, so no caller can claim a run it did not make.
 */
export const buildDecisionAnalysis = ({
  generatedAt,
  inputFingerprint,
  language,
  model,
  output,
}: BuildAnalysisOptions): DecisionAnalysisV3 => ({
  version: CURRENT_ANALYSIS_VERSION,
  generatedAt: generatedAt.toISOString(),
  model,
  inputFingerprint,
  tree: output.headings.map((heading) =>
    createAnalysisHeading({ heading, language }),
  ),
  holding: {
    text: output.holding.text,
    language,
    anchors: output.holding.anchors,
  },
  abstract: { text: output.abstract, language },
  topics: output.topics,
});
