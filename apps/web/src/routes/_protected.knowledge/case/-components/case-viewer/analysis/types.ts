import type React from "react";

import type {
  AnalysisAnnotation,
  AnalysisHeading,
} from "@stll/case-law/analysis";

export type {
  AnalysisAnnotation,
  AnalysisHeading,
} from "@stll/case-law/analysis";

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
  // eslint-disable-next-line no-inline-style-colors/no-inline-style-colors -- CSS variable name, not a color value
  facts: "--option-blue",
  "procedural-history": "--option-amber",
  reasoning: "--option-violet",
  holding: "--option-emerald",
};

const hashString = (s: string): number => {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    // djb2-style hash: bitwise ops are the correct tool here.
    // eslint-disable-next-line no-bitwise, unicorn/prefer-math-trunc
    h = ((h << 5) - h + (s.codePointAt(i) ?? 0)) | 0;
  }
  return Math.abs(h);
};

/** Get the CSS variable name for a category's color. */
export const getCategoryVar = (category: string): string => {
  const fixed = CORE_CATEGORY_VAR[category];
  if (fixed) {
    return fixed;
  }
  const idx = hashString(category) % OPTION_VARS.length;
  // idx is in [0, length); indexing is safe.
  return OPTION_VARS[idx] ?? OPTION_VARS[0] ?? "";
};

/** Inline style for using a category color. */
export const categoryColorStyle = (category: string): React.CSSProperties => ({
  borderInlineStartColor: `var(${getCategoryVar(category)})`,
});

/** Inline style for subtle line (low opacity). */
export const categoryLineStyle = (category: string): React.CSSProperties => ({
  borderInlineStartColor: `color-mix(in srgb, var(${getCategoryVar(category)}) 25%, transparent)`,
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
export const getCategoryI18nKey = (category: string): string | null =>
  CATEGORY_I18N[category] ?? null;

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

export const buildSectionMap = (
  headings: readonly AnalysisHeading[],
  allAnchorIds: readonly string[],
): Map<string, SectionInfo> => {
  const map = new Map<string, SectionInfo>();
  const idxMap = new Map(allAnchorIds.map((id, i) => [id, i]));

  const mapRange = ({
    cssVar,
    endAnchorId,
    headingId,
    startAnchorId,
  }: {
    cssVar: string;
    endAnchorId: string;
    headingId: string;
    startAnchorId: string;
  }) => {
    const start = idxMap.get(startAnchorId);
    const end = idxMap.get(endAnchorId);
    if (start === undefined || end === undefined) {
      return;
    }

    for (let i = start; i <= end; i++) {
      const anchorId = allAnchorIds[i];
      if (anchorId && !map.has(anchorId)) {
        map.set(anchorId, { cssVar, headingId });
      }
    }
  };

  const walk = (nodes: readonly AnalysisHeading[]) => {
    for (const node of nodes) {
      const cssVar = getCategoryVar(node.category);
      for (const annotation of node.annotations) {
        mapRange({
          cssVar,
          endAnchorId: annotation.endAnchorId,
          headingId: annotation.id,
          startAnchorId: annotation.startAnchorId,
        });
      }
      walk(node.children);
    }
  };

  walk(headings);
  return map;
};

export const flattenAnnotations = (
  headings: readonly AnalysisHeading[],
): FlatAnnotation[] => {
  const result: FlatAnnotation[] = [];

  const walk = (nodes: readonly AnalysisHeading[]) => {
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
