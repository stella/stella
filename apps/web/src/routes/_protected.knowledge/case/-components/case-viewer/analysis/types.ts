import type React from "react";

import type {
  AnalysisAnnotation,
  AnalysisHeading,
} from "@stella/case-law/analysis";

export type {
  AnalysisAnnotation,
  AnalysisHeading,
} from "@stella/case-law/analysis";

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

/**
 * Build a map from anchorId to section info.
 */
// Defensive clamp thresholds. When the AI produces a heading
// whose range runs from the first to (nearly) the last block —
// swallowing the whole decision — treat it as a hallucination
// and collapse it to just its first block. Triggering requires
// all three conditions: spans at least this many blocks, covers
// at least this fraction of the decision, and actually crosses
// at least one sibling heading's range.
const RUNAWAY_MIN_BLOCKS = 5;
const RUNAWAY_MIN_COVERAGE = 0.5;

type HeadingRange = { start: number; end: number };

/**
 * Collect all ranges AND map each candidate to the set of its
 * descendant ranges. The runaway detector then compares a
 * candidate only against non-descendant ranges so a legitimate
 * parent that spans its own children is never flagged as
 * swallowing them. `children` is empty today but the API
 * surface allows nested headings, so we future-proof here.
 */
const rangeKey = (r: HeadingRange): string => `${r.start}:${r.end}`;

/**
 * Collect all heading ranges across the tree, keeping track of
 * each node's own descendant ranges keyed by "start:end". The
 * runaway detector compares a candidate only against
 * non-descendant ranges so a legitimate parent that spans its
 * own children is never flagged as swallowing them. `children`
 * is empty in today's analyses but the type allows nesting.
 */
const collectRanges = (
  nodes: readonly AnalysisHeading[],
  idxMap: Map<string, number>,
): { all: HeadingRange[]; descendantsByKey: Map<string, Set<string>> } => {
  const all: HeadingRange[] = [];
  const descendantsByKey = new Map<string, Set<string>>();

  const walk = (subtree: readonly AnalysisHeading[]): string[] => {
    const subKeys: string[] = [];
    for (const node of subtree) {
      const start = idxMap.get(node.startAnchorId);
      const end = idxMap.get(node.endAnchorId);
      let nodeKey: string | null = null;
      if (start !== undefined && end !== undefined) {
        const range = { start, end };
        nodeKey = rangeKey(range);
        all.push(range);
        subKeys.push(nodeKey);
      }
      const childKeys = walk(node.children);
      if (nodeKey) {
        descendantsByKey.set(nodeKey, new Set(childKeys));
        subKeys.push(...childKeys);
      }
    }
    return subKeys;
  };

  walk(nodes);
  return { all, descendantsByKey };
};

const crossesAnotherRange = (
  candidate: HeadingRange,
  all: readonly HeadingRange[],
  descendants: Set<string>,
): boolean => {
  const candidateKey = rangeKey(candidate);
  for (const other of all) {
    const otherKey = rangeKey(other);
    if (otherKey === candidateKey || descendants.has(otherKey)) {
      continue;
    }
    const overlaps =
      other.start <= candidate.end && other.end >= candidate.start;
    if (!overlaps) {
      continue;
    }
    const candidateContainsOther =
      candidate.start <= other.start && candidate.end >= other.end;
    const otherContainsCandidate =
      other.start <= candidate.start && other.end >= candidate.end;
    if (otherContainsCandidate) {
      // Candidate is nested inside `other` — legitimate (just
      // a narrower range), not a runaway signal.
      continue;
    }
    if (!candidateContainsOther) {
      // Partial overlap that crosses `other`'s boundary — a
      // real signal that the candidate span is wrong.
      return true;
    }
    if (other.start > candidate.start || other.end < candidate.end) {
      // Candidate strictly swallows `other` — runaway.
      return true;
    }
  }
  return false;
};

export const buildSectionMap = (
  headings: readonly AnalysisHeading[],
  allAnchorIds: readonly string[],
): Map<string, SectionInfo> => {
  const map = new Map<string, SectionInfo>();
  const idxMap = new Map(allAnchorIds.map((id, i) => [id, i]));

  const { all: allRanges, descendantsByKey } = collectRanges(headings, idxMap);

  const walk = (nodes: readonly AnalysisHeading[]) => {
    for (const node of nodes) {
      const start = idxMap.get(node.startAnchorId);
      const end = idxMap.get(node.endAnchorId);
      if (start !== undefined && end !== undefined) {
        const cssVar = getCategoryVar(node.category);
        const blockCount = end - start + 1;
        const coverage =
          allAnchorIds.length > 0 ? blockCount / allAnchorIds.length : 0;
        const candidate = { start, end };
        const ownDescendants =
          descendantsByKey.get(rangeKey(candidate)) ?? new Set<string>();
        const effectiveEnd =
          blockCount >= RUNAWAY_MIN_BLOCKS &&
          coverage >= RUNAWAY_MIN_COVERAGE &&
          crossesAnotherRange(candidate, allRanges, ownDescendants)
            ? start
            : end;
        for (let i = start; i <= effectiveEnd; i++) {
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
