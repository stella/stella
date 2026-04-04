/**
 * Frontend mirror of the backend analysis types.
 * Kept minimal — only what the UI needs.
 */

import type React from "react";

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

// ── Color system ──────────────────────────────────────────
//
// Uses --option-* CSS variables from globals.css so colors
// adapt to all theme palettes (neutral, nord, flexoki).

/**
 * CSS variable name for a category's accent color.
 * Core categories get fixed assignments; non-standard ones
 * get a stable hash-based pick from the remaining palette.
 */

const OPTION_VARS = [
  "--option-blue",
  "--option-amber",
  "--option-violet",
  "--option-emerald",
  "--option-cyan",
  "--option-orange",
  "--option-indigo",
  "--option-teal",
] as const;

const CORE_CATEGORY_VAR: Record<string, string> = {
  facts: "--option-blue",
  "procedural-history": "--option-amber",
  reasoning: "--option-violet",
  holding: "--option-emerald",
};

const hashString = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
};

/** Get the CSS variable name for a category's color. */
export const getCategoryVar = (category: string): string => {
  const fixed = CORE_CATEGORY_VAR[category];
  if (fixed) return fixed;
  const idx = hashString(category) % OPTION_VARS.length;
  return OPTION_VARS[idx]!;
};

/** Inline style for using a category color. */
export const categoryColorStyle = (
  category: string,
): React.CSSProperties => ({
  borderLeftColor: `var(${getCategoryVar(category)})`,
});

/** Inline style for subtle line (low opacity). */
export const categoryLineStyle = (
  category: string,
): React.CSSProperties => ({
  borderLeftColor: `color-mix(in srgb, var(${getCategoryVar(category)}) 25%, transparent)`,
});

/** i18n key for a category. Used with useTranslations(). */
const CATEGORY_I18N: Record<string, string> = {
  facts: "caseLaw.analysis.categories.facts",
  "procedural-history": "caseLaw.analysis.categories.procedural-history",
  reasoning: "caseLaw.analysis.categories.reasoning",
  holding: "caseLaw.analysis.categories.holding",
};

/**
 * Get the translated label for a category.
 * Pass the `t` function from useTranslations().
 * Falls back to capitalising the raw key for unknown categories.
 */
export const formatCategoryLabel = (category: string): string =>
  category.replace(/-/g, " ");

/** Get the i18n message key for a core category, or null. */
export const getCategoryI18nKey = (
  category: string,
): string | null => CATEGORY_I18N[category] ?? null;

/**
 * Flatten the heading tree into a list of all annotations
 * with their parent heading context.
 */
export type FlatAnnotation = AnalysisAnnotation & {
  headingLabel: string;
  category: string;
};

/**
 * Section info per anchor: CSS variable + heading ID for grouping.
 */
export type SectionInfo = { cssVar: string; headingId: string };

/**
 * Build a map from anchorId to section info.
 */
export const buildSectionMap = (
  headings: AnalysisHeading[],
  allAnchorIds: string[],
): Map<string, SectionInfo> => {
  const map = new Map<string, SectionInfo>();
  const idxMap = new Map(allAnchorIds.map((id, i) => [id, i]));

  const walk = (nodes: AnalysisHeading[]) => {
    for (const node of nodes) {
      const start = idxMap.get(node.startAnchorId);
      const end = idxMap.get(node.endAnchorId);
      if (start !== undefined && end !== undefined) {
        const cssVar = getCategoryVar(node.category);
        for (let i = start; i <= end; i++) {
          const anchorId = allAnchorIds[i];
          if (anchorId && !map.has(anchorId)) {
            map.set(anchorId, { cssVar, headingId: node.id });
          }
        }
      }
      walk(node.children);
    }
  };

  walk(headings);
  return map;
};

export const flattenAnnotations = (
  headings: AnalysisHeading[],
): FlatAnnotation[] => {
  const result: FlatAnnotation[] = [];

  const walk = (nodes: AnalysisHeading[]) => {
    for (const node of nodes) {
      for (const annotation of node.annotations) {
        result.push({
          ...annotation,
          headingLabel: node.label,
          category: node.category,
        });
      }
      walk(node.children);
    }
  };

  walk(headings);
  return result;
};
