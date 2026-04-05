/**
 * AI-generated decision analysis types.
 *
 * One hierarchical tree of headings + annotations, anchored to
 * paragraph ranges in the decision AST. Three UI projections:
 * heading breadcrumb, margin annotations, navigation panel.
 */

import * as v from "valibot";

// ── Core category taxonomy ────────────────────────────────

/**
 * Core categories always used when applicable. The AI may
 * add jurisdiction-specific labels as free-form strings.
 */
export const CORE_CATEGORIES = [
  "facts",
  "procedural-history",
  "reasoning",
  "holding",
] as const;

export type CoreCategory = (typeof CORE_CATEGORIES)[number];

// ── TypeScript types (source of truth) ────────────────────

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

// ── Valibot schemas (for AI output validation) ────────────

export const analysisAnnotationSchema = v.object({
  id: v.string(),
  summary: v.pipe(v.string(), v.minLength(1)),
  startAnchorId: v.string(),
  endAnchorId: v.string(),
  // No length constraint: the prompt asks for short snippets,
  // but models routinely over-shoot — and ai-sdk's array output
  // silently drops any element whose nested validation fails,
  // which would collapse the whole heading (and any sibling
  // headings scanned in the same stream). Accept what the model
  // gives us; the UI truncates for display.
  textSnippet: v.string(),
});

// Flat heading schema for AI output (no recursive children).
// Gemini rejects recursive $defs. The model outputs a flat
// array; the pipeline can nest them post-hoc if needed.
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

// ── Sentinel for concurrent generation guard ──────────────

export type AnalysisGenerating = {
  status: "generating";
  startedAt: string;
};

export const isAnalysisGenerating = (val: unknown): val is AnalysisGenerating =>
  typeof val === "object" &&
  val !== null &&
  "status" in val &&
  (val as Record<string, unknown>).status === "generating";

export const isDecisionAnalysis = (val: unknown): val is DecisionAnalysis =>
  typeof val === "object" &&
  val !== null &&
  "version" in val &&
  "tree" in val &&
  Array.isArray((val as Record<string, unknown>).tree);
