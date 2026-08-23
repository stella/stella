/**
 * Shared analysis model for AI-generated decision summaries.
 */

import * as v from "valibot";

export const CORE_CATEGORIES = [
  "facts",
  "procedural-history",
  "reasoning",
  "holding",
] as const;

export type CoreCategory = (typeof CORE_CATEGORIES)[number];

export type AnalysisAnnotation = {
  id: string;
  summary: string;
  startAnchorId: string;
  endAnchorId: string;
  textSnippet: string;
};

export type AnalysisHeading = {
  id: string;
  label: string;
  category: string;
  startAnchorId: string;
  endAnchorId: string;
  annotations: AnalysisAnnotation[];
  children: AnalysisHeading[];
};

export type DecisionAnalysis = {
  version: 1;
  generatedAt: string;
  model: string;
  tree: AnalysisHeading[];
};

export type AnalysisGenerating = {
  version: 1;
  status: "generating";
  startedAt: string;
};

export type AnalysisInProgress = DecisionAnalysis & {
  status: "generating";
};

export type PersistedDecisionAnalysis =
  | DecisionAnalysis
  | AnalysisInProgress
  | AnalysisGenerating;

export const analysisAnnotationSchema: v.GenericSchema<AnalysisAnnotation> =
  v.object({
    id: v.string(),
    summary: v.pipe(v.string(), v.minLength(1)),
    startAnchorId: v.string(),
    endAnchorId: v.string(),
    // No length constraint: the prompt asks for short snippets,
    // but models routinely over-shoot. The UI truncates for display.
    textSnippet: v.string(),
  });

/** Schema for one heading emitted by the AI before Stella adds stable IDs and children. */
export const analysisHeadingInputSchema = v.object({
  id: v.string(),
  label: v.pipe(v.string(), v.minLength(1)),
  category: v.string(),
  startAnchorId: v.string(),
  endAnchorId: v.string(),
  annotations: v.array(analysisAnnotationSchema),
});

/** Complete persisted heading schema, including recursively nested children. */
export const analysisHeadingSchema: v.GenericSchema<AnalysisHeading> = v.object(
  {
    id: v.string(),
    label: v.pipe(v.string(), v.minLength(1)),
    category: v.string(),
    startAnchorId: v.string(),
    endAnchorId: v.string(),
    annotations: v.array(analysisAnnotationSchema),
    children: v.array(v.lazy(() => analysisHeadingSchema)),
  },
);

export const decisionAnalysisSchema: v.GenericSchema<DecisionAnalysis> =
  v.strictObject({
    version: v.literal(1),
    generatedAt: v.string(),
    model: v.string(),
    tree: v.array(analysisHeadingSchema),
  });

const analysisInProgressSchema: v.GenericSchema<AnalysisInProgress> =
  v.strictObject({
    version: v.literal(1),
    generatedAt: v.string(),
    model: v.string(),
    tree: v.array(analysisHeadingSchema),
    status: v.literal("generating"),
  });

const analysisGeneratingSchema: v.GenericSchema<AnalysisGenerating> =
  v.strictObject({
    version: v.literal(1),
    status: v.literal("generating"),
    startedAt: v.string(),
  });

const persistedDecisionAnalysisSchema: v.GenericSchema<PersistedDecisionAnalysis> =
  v.union([
    analysisInProgressSchema,
    analysisGeneratingSchema,
    decisionAnalysisSchema,
  ]);

export const isAnalysisGenerating = (val: unknown): val is AnalysisGenerating =>
  v.is(analysisGeneratingSchema, val);

export const isDecisionAnalysis = (val: unknown): val is DecisionAnalysis =>
  v.is(decisionAnalysisSchema, val);

export const isAnalysisInProgress = (val: unknown): val is AnalysisInProgress =>
  v.is(analysisInProgressSchema, val);

export const parsePersistedDecisionAnalysis = (
  val: unknown,
): PersistedDecisionAnalysis | null => {
  let candidate = val;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }

  const result = v.safeParse(persistedDecisionAnalysisSchema, candidate);
  return result.success ? result.output : null;
};
