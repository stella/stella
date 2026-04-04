/**
 * Re-anchor analysis annotations when a decision's AST is re-parsed.
 *
 * When the parser version changes, block anchorIds may shift.
 * This module fuzzy-matches textSnippets from existing annotations
 * against the new block plainText fields to find the best match.
 */

import type { Block } from "@/api/handlers/case-law/document-ast";

import type {
  AnalysisAnnotation,
  AnalysisHeading,
  DecisionAnalysis,
} from "./types";

/**
 * Longest common substring length between two strings.
 * Used for fuzzy matching text snippets.
 */
const lcsLength = (a: string, b: string): number => {
  const m = a.length;
  const n = b.length;
  if (m === 0 || n === 0) {
    return 0;
  }

  let maxLen = 0;
  let prev = new Uint16Array(n + 1);
  let curr = new Uint16Array(n + 1);

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        const val = (prev[j - 1] ?? 0) + 1;
        curr[j] = val;
        if (val > maxLen) {
          maxLen = val;
        }
      } else {
        curr[j] = 0;
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }

  return maxLen;
};

/**
 * Find the best matching block for a text snippet.
 * Returns the block's anchorId or null if no good match.
 */
const findBestMatch = (
  snippet: string,
  blocks: Block[],
  threshold = 0.6,
): string | null => {
  if (!snippet || snippet.length === 0) {
    return null;
  }

  let bestId: string | null = null;
  let bestScore = 0;

  for (const block of blocks) {
    const text = block.plainText;
    if (!text) {
      continue;
    }

    // Quick check: if the block contains the snippet, it's a match
    if (text.includes(snippet)) {
      return block.anchorId;
    }

    // Fuzzy match using longest common substring
    const score = lcsLength(snippet, text) / snippet.length;
    if (score > bestScore && score >= threshold) {
      bestScore = score;
      bestId = block.anchorId;
    }
  }

  return bestId;
};

/**
 * Re-anchor a single annotation against new blocks.
 */
const reconcileAnnotation = (
  annotation: AnalysisAnnotation,
  blocks: Block[],
): AnalysisAnnotation | null => {
  const newStart = findBestMatch(annotation.textSnippet, blocks);
  if (!newStart) {
    return null;
  }

  // AnalysisAnnotation carries a single textSnippet, so after
  // re-anchoring we collapse the span to the matched block.
  // Multi-block spans can be rebuilt when the analysis is next
  // regenerated.
  return {
    ...annotation,
    startAnchorId: newStart,
    endAnchorId: newStart,
  };
};

/**
 * Re-anchor a heading and its children/annotations.
 */
const reconcileHeading = (
  heading: AnalysisHeading,
  blocks: Block[],
): AnalysisHeading | null => {
  const reconciledAnnotations = heading.annotations
    .map((a) => reconcileAnnotation(a, blocks))
    .filter((a): a is AnalysisAnnotation => a !== null);

  const reconciledChildren = heading.children
    .map((c) => reconcileHeading(c, blocks))
    .filter((c): c is AnalysisHeading => c !== null);

  // If all annotations and children were lost, drop the heading
  if (reconciledAnnotations.length === 0 && reconciledChildren.length === 0) {
    return null;
  }

  // Re-anchor the heading's own range from the first annotation/child
  const firstAnnotation = reconciledAnnotations[0];
  const firstChild = reconciledChildren[0];
  const newStart =
    firstAnnotation?.startAnchorId ??
    firstChild?.startAnchorId ??
    heading.startAnchorId;

  const lastAnnotation = reconciledAnnotations.at(-1);
  const lastChild = reconciledChildren.at(-1);
  const newEnd =
    lastAnnotation?.endAnchorId ??
    lastChild?.endAnchorId ??
    heading.endAnchorId;

  return {
    ...heading,
    startAnchorId: newStart,
    endAnchorId: newEnd,
    annotations: reconciledAnnotations,
    children: reconciledChildren,
  };
};

/**
 * Reconcile an entire analysis tree against new AST blocks.
 * Returns the updated analysis, or null if reconciliation
 * resulted in an empty tree (caller should regenerate).
 */
export const reconcileAnalysis = (
  analysis: DecisionAnalysis,
  newBlocks: Block[],
): DecisionAnalysis | null => {
  const reconciledTree = analysis.tree
    .map((h) => reconcileHeading(h, newBlocks))
    .filter((h): h is AnalysisHeading => h !== null);

  if (reconciledTree.length === 0) {
    return null;
  }

  return {
    ...analysis,
    tree: reconciledTree,
  };
};
