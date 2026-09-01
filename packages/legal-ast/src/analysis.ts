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

/**
 * The document an analysis was computed over, as one value: a digest of
 * the exact text the model was shown, anchors included. Every anchor in
 * the tree names a block of that text, so an analysis whose fingerprint
 * differs from the current document's is stale, not merely old: a
 * re-parse that renumbers blocks moves every note onto the wrong
 * paragraph while the words stay the same. Readers compare before they
 * trust; a mismatch reads as no analysis.
 */
export type AnalysisInputFingerprint = string;

export type DecisionAnalysis = {
  version: 2;
  generatedAt: string;
  model: string;
  inputFingerprint: AnalysisInputFingerprint;
  tree: AnalysisHeading[];
};

/** The in-flight marker a generation run holds on the row. */
export type AnalysisGenerating = {
  version: 2;
  status: "generating";
  startedAt: string;
  inputFingerprint: AnalysisInputFingerprint;
};

export type PersistedDecisionAnalysis = DecisionAnalysis | AnalysisGenerating;

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

const inputFingerprintSchema = v.pipe(v.string(), v.minLength(1));

/**
 * Version 1 carried no fingerprint, so nothing could tell whether its
 * anchors still named the document. Such a row is unreadable here on
 * purpose: it reads as no analysis and is regenerated against the current
 * document on the next open.
 */
export const decisionAnalysisSchema: v.GenericSchema<DecisionAnalysis> =
  v.strictObject({
    version: v.literal(2),
    generatedAt: v.string(),
    model: v.string(),
    inputFingerprint: inputFingerprintSchema,
    tree: v.array(analysisHeadingSchema),
  });

const analysisGeneratingSchema: v.GenericSchema<AnalysisGenerating> =
  v.strictObject({
    version: v.literal(2),
    status: v.literal("generating"),
    startedAt: v.string(),
    inputFingerprint: inputFingerprintSchema,
  });

const persistedDecisionAnalysisSchema: v.GenericSchema<PersistedDecisionAnalysis> =
  v.union([analysisGeneratingSchema, decisionAnalysisSchema]);

export const isAnalysisGenerating = (val: unknown): val is AnalysisGenerating =>
  v.is(analysisGeneratingSchema, val);

export const isDecisionAnalysis = (val: unknown): val is DecisionAnalysis =>
  v.is(decisionAnalysisSchema, val);

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
