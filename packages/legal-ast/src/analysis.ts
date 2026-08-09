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
  v.object({
    version: v.literal(1),
    generatedAt: v.string(),
    model: v.string(),
    tree: v.array(analysisHeadingSchema),
  });

const analysisInProgressSchema: v.GenericSchema<AnalysisInProgress> = v.object({
  version: v.literal(1),
  generatedAt: v.string(),
  model: v.string(),
  tree: v.array(analysisHeadingSchema),
  status: v.literal("generating"),
});

const analysisGeneratingSchema: v.GenericSchema<AnalysisGenerating> = v.object({
  version: v.literal(1),
  status: v.literal("generating"),
  startedAt: v.string(),
});

export const isAnalysisGenerating = (val: unknown): val is AnalysisGenerating =>
  v.safeParse(analysisGeneratingSchema, val).success;

export const isDecisionAnalysis = (val: unknown): val is DecisionAnalysis =>
  v.safeParse(decisionAnalysisSchema, val).success &&
  !(typeof val === "object" && val !== null && Object.hasOwn(val, "status"));

export const isAnalysisInProgress = (val: unknown): val is AnalysisInProgress =>
  v.safeParse(analysisInProgressSchema, val).success;

export const parsePersistedDecisionAnalysis = (
  val: unknown,
): PersistedDecisionAnalysis | null => {
  if (
    isAnalysisInProgress(val) ||
    isDecisionAnalysis(val) ||
    isAnalysisGenerating(val)
  ) {
    return val;
  }

  if (typeof val !== "string") {
    return null;
  }

  try {
    return parsePersistedDecisionAnalysis(JSON.parse(val));
  } catch {
    return null;
  }
};
