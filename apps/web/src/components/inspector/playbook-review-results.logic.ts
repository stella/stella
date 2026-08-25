/**
 * The findings list a reviewer reads: one card per confirmed position, in one
 * order, under one of two filters.
 *
 * A run holds exactly one finding per position, so there is no join to
 * reconcile here — only the position each finding was graded against (for the
 * standard the card quotes) and the order the list is read in.
 */

import type {
  ReferenceFile,
  ReviewPerspective,
} from "@/components/ai-suggestions/document-review-basis.logic";
import type { ReviewFinding } from "@/components/ai-suggestions/document-review-queries";
import { isDecisionSettled } from "@/components/ai-suggestions/document-review-run.logic";
import type {
  PinnedPosition,
  RestoredReviewFinding,
} from "@/components/ai-suggestions/document-review-run.logic";
import {
  isFlaggedVerdict,
  SEVERITY_ORDER,
} from "@/components/ai-suggestions/review-verdict";

export type ReviewResultItem = RestoredReviewFinding & {
  /** The position this finding was graded against, or `null` when the run's
   *  snapshot no longer names it (a finding the plan dropped). */
  position: PinnedPosition | null;
  /** Where the position sits in the confirmed list; the stable tie-break. */
  order: number;
};

type BuildReviewResultItemsArgs = {
  positions: readonly PinnedPosition[];
  findings: readonly RestoredReviewFinding[];
};

export const buildReviewResultItems = ({
  positions,
  findings,
}: BuildReviewResultItemsArgs): ReviewResultItem[] => {
  const byPositionId = new Map(
    positions.map((position, index) => [
      position.sourceId,
      { position, index },
    ]),
  );
  return findings.map((row) => {
    const match = byPositionId.get(row.positionId);
    return {
      ...row,
      position: match?.position ?? null,
      order: match?.index ?? positions.length,
    };
  });
};

/**
 * Whether the finding itself is one a reviewer has to answer, before any
 * disposition is taken. Kept separate from the decision so the two questions —
 * "is this a problem?" and "has someone dealt with it?" — never merge.
 *
 * A comparison judged for a side answers the question directly: a difference
 * that leaves that side worse off needs the reviewer whatever its verdict.
 * Otherwise the verdict decides.
 */
export const isReviewDeviation = ({ finding }: ReviewResultItem): boolean => {
  if (finding.impact === "unfavourable") {
    return true;
  }
  return finding.verdict !== null && isFlaggedVerdict(finding.verdict);
};

/** What the "Deviations" filter shows: a deviation nobody has disposed of. */
export const isUndecidedDeviation = (item: ReviewResultItem): boolean =>
  !isDecisionSettled(item.decision) && isReviewDeviation(item);

/** The two lists the results offer: every position the run covered, or only
 *  the ones that still need an answer. */
export const REVIEW_RESULT_FILTERS = ["coverage", "deviations"] as const;
export type ReviewResultFilter = (typeof REVIEW_RESULT_FILTERS)[number];

const severityRank = (severity: ReviewFinding["severity"]): number =>
  SEVERITY_ORDER.indexOf(severity);

/**
 * The list a reviewer reads top to bottom: the most severe positions first,
 * then the order the positions were confirmed in. Direction and verdict are
 * not sorted on — the card's glyph column carries those — so the same position
 * keeps the same place across runs.
 */
export const sortReviewResultItems = (
  items: readonly ReviewResultItem[],
): ReviewResultItem[] =>
  items
    .slice()
    .sort(
      (a, b) =>
        severityRank(a.finding.severity) - severityRank(b.finding.severity) ||
        a.order - b.order,
    );

// TODO(i18n): English until the review surface is localized as a whole.
const PROPOSED_FROM_REFERENCES_LABEL = "positions proposed from the references";
const NO_SIDE_LABEL = "no side";
const SUMMARY_SEPARATOR = " · ";

type RunSummaryArgs = {
  /** The reviewed document's name, or `""` while it is not known yet. */
  targetName: string;
  /** Its version number at the moment the run pinned it, when resolvable. */
  targetVersionNumber: number | null;
  references: readonly ReferenceFile[];
  /** The pinned playbook's name; ignored for a run whose positions were only
   *  ever confirmed for it. */
  playbookName: string;
  playbookProposed: boolean;
  perspective: ReviewPerspective;
};

/**
 * What the run actually read, in one line: the document and version it
 * measured, the references it was compared against, where its positions came
 * from, and the side it was judged for.
 *
 * Built here rather than in JSX so the sentence is one testable value — a
 * completed run has to keep describing itself after every one of those has
 * moved on.
 */
export const buildRunSummarySentence = ({
  targetName,
  targetVersionNumber,
  references,
  playbookName,
  playbookProposed,
  perspective,
}: RunSummaryArgs): string => {
  const parts: string[] = [];
  if (targetName.length > 0) {
    parts.push(
      targetVersionNumber === null
        ? targetName
        : `${targetName} v${String(targetVersionNumber)}`,
    );
  }
  if (references.length > 0) {
    parts.push(references.map((reference) => reference.name).join(", "));
  }
  parts.push(
    playbookProposed || playbookName.length === 0
      ? PROPOSED_FROM_REFERENCES_LABEL
      : playbookName,
  );
  parts.push(
    perspective.type === "party"
      ? `for the ${perspective.role}`
      : NO_SIDE_LABEL,
  );
  return parts.join(SUMMARY_SEPARATOR);
};
