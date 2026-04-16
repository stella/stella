/**
 * Shared analysis model for AI-generated decision summaries.
 */

import * as v from "valibot";

const isRecord = (val: unknown): val is Record<string, unknown> =>
  typeof val === "object" && val !== null;

const hasGeneratingStatus = (
  val: unknown,
): val is { status: "generating" } => isRecord(val) && val.status === "generating";

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

export const analysisAnnotationSchema = v.object({
  id: v.string(),
  summary: v.pipe(v.string(), v.minLength(1)),
  startAnchorId: v.string(),
  endAnchorId: v.string(),
  // No length constraint: the prompt asks for short snippets,
  // but models routinely over-shoot. The UI truncates for display.
  textSnippet: v.string(),
});

export const analysisHeadingSchema = v.object({
  id: v.string(),
  label: v.pipe(v.string(), v.minLength(1)),
  category: v.string(),
  startAnchorId: v.string(),
  endAnchorId: v.string(),
  annotations: v.array(analysisAnnotationSchema),
});

export const decisionAnalysisSchema = v.object({
  version: v.literal(1),
  generatedAt: v.string(),
  model: v.string(),
  tree: v.array(analysisHeadingSchema),
});

export const isAnalysisGenerating = (val: unknown): val is AnalysisGenerating =>
  isRecord(val) &&
  val.status === "generating" &&
  typeof val.startedAt === "string";

export const isDecisionAnalysis = (val: unknown): val is DecisionAnalysis =>
  isRecord(val) &&
  val.version === 1 &&
  typeof val.generatedAt === "string" &&
  typeof val.model === "string" &&
  Array.isArray(val.tree);

export const isAnalysisInProgress = (
  val: unknown,
): val is AnalysisInProgress =>
  isDecisionAnalysis(val) && hasGeneratingStatus(val);
