import type { AnalysisHeading } from "@stll/legal-ast/analysis";

export type {
  AnalysisAnnotation,
  AnalysisHeading,
} from "@stll/legal-ast/analysis";

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
    // eslint-disable-next-line no-bitwise, unicorn/prefer-math-trunc -- djb2 hash needs shift and `| 0` int coercion
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
  return OPTION_VARS[idx] ?? "";
};

export type FlatAnalysisHeading = AnalysisHeading & {
  depth: number;
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

export const flattenAnalysisHeadings = (
  headings: readonly AnalysisHeading[],
): FlatAnalysisHeading[] => {
  const result: FlatAnalysisHeading[] = [];

  const walk = (nodes: readonly AnalysisHeading[], depth: number) => {
    for (const node of nodes) {
      result.push({ ...node, depth });
      walk(node.children, depth + 1);
    }
  };

  walk(headings, 0);
  return result;
};
