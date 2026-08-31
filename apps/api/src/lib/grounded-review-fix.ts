/**
 * The one-click redline a finding carries, derived from its delta.
 *
 * The operation is never the model's choice. A changed number is a substring
 * replacement inside the block that states it; a missing limb is an insertion
 * after the block it belongs with; only a genuine wording difference replaces
 * a whole block. The vocabulary matches the folio editor's AI-edit ops
 * (`packages/folio` ai-edits/types.ts), so the frontend feeds a fix straight
 * into `applyAIEditOperations`.
 */

import type { ReviewDelta } from "@/api/lib/document-review/review-delta";
import type { DocxFolioCitation } from "@/api/lib/document-review/review-extract";

export type GroundedReviewFix =
  | { kind: "replaceInBlock"; blockId: string; find: string; replace: string }
  | { kind: "replaceBlock"; blockId: string; text: string }
  | { kind: "insertAfterBlock"; blockId: string; text: string };

type BuildGroundedReviewFixArgs = {
  delta: ReviewDelta;
  /** The standard's wording for this position, when one is available. Used by
   *  every delta kind except `parameter`, which replaces only the term. */
  proposedText: string | null | undefined;
  /** Whether the standard side of the comparison was actually grounded (a
   *  verified passage, resolved ideal language). An ungrounded conclusion
   *  never becomes an executable edit. */
  supportingEvidenceVerified: boolean;
  /** Verified target citations, in the order the engine cited them. The first
   *  is the semantic anchor; this boundary never invents one from position. */
  targetAnchors: readonly DocxFolioCitation[];
};

/** Occurrences of `needle` in `haystack`; `needle` is never empty here. */
const countOccurrences = (haystack: string, needle: string): number => {
  let count = 0;
  let cursor = haystack.indexOf(needle);
  while (cursor !== -1) {
    count += 1;
    cursor = haystack.indexOf(needle, cursor + needle.length);
  }
  return count;
};

/**
 * A parameter edit rewrites the term, not the paragraph, so the term must be
 * locatable in the cited block without ambiguity: exactly one occurrence, or
 * no fix at all. Two occurrences mean the engine cannot say which one the
 * finding is about, and an editor must.
 */
const buildParameterFix = (
  delta: Extract<ReviewDelta, { kind: "parameter" }>,
  proposedText: string | null | undefined,
): GroundedReviewFix | null => {
  const target = delta.target;
  if (target === null) {
    return null;
  }
  const find = target.text.trim();
  const replace = (delta.standard?.text ?? proposedText)?.trim();
  if (find.length === 0 || !replace || find === replace) {
    return null;
  }
  if (countOccurrences(target.citation.text, find) !== 1) {
    return null;
  }
  return {
    kind: "replaceInBlock",
    blockId: target.citation.blockId,
    find,
    replace,
  };
};

/**
 * Build an executable document edit from verified evidence and a verified
 * target anchor, with the operation fixed by the delta's kind.
 */
export const buildGroundedReviewFix = ({
  delta,
  proposedText,
  supportingEvidenceVerified,
  targetAnchors,
}: BuildGroundedReviewFixArgs): GroundedReviewFix | null => {
  if (!supportingEvidenceVerified) {
    return null;
  }
  if (delta.kind === "parameter") {
    return buildParameterFix(delta, proposedText);
  }

  const text = proposedText?.trim();
  const blockId = targetAnchors.at(0)?.blockId;
  if (!text || blockId === undefined) {
    return null;
  }
  switch (delta.kind) {
    // A limb the document does not have, and a term it never states, are both
    // additions: the surrounding wording stays and the new text follows the
    // block it belongs with.
    case "enumeration":
    case "presence":
      return { kind: "insertAfterBlock", blockId, text };
    case "language":
      return { kind: "replaceBlock", blockId, text };
    default:
      delta satisfies never;
      return null;
  }
};
