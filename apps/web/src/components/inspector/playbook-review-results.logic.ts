/**
 * The findings list a reviewer reads: one card per confirmed position, in one
 * order, under one of two filters.
 *
 * A run holds exactly one finding per position, so there is no join to
 * reconcile here — only the position each finding was graded against (for the
 * standard the card quotes) and the order the list is read in.
 */

import type { ReviewFlag } from "@stll/api-contract";

import type { ReferenceFile } from "@/components/ai-suggestions/document-review-basis.logic";
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

export type ReviewFlagTally = Record<ReviewFlag, number>;

/** Written out per member rather than built from the list, for the same reason
 *  the decision tally is: a flag added to the vocabulary fails typecheck here
 *  instead of quietly counting nothing. */
const emptyFlagTally = (): ReviewFlagTally => ({
  "needs-review": 0,
  important: 0,
  "follow-up": 0,
  contradiction: 0,
  verified: 0,
});

/** How many of the listed findings carry each flag. Total over the vocabulary,
 *  so a chip exists for every flag whether or not anything wears it. */
export const tallyReviewFlags = (
  items: readonly ReviewResultItem[],
): ReviewFlagTally => {
  const counts = emptyFlagTally();
  for (const item of items) {
    for (const flag of item.flags) {
      counts[flag] += 1;
    }
  }
  return counts;
};

/**
 * Tokens that end in a period without ending a sentence.
 *
 * Deliberately short, and the split is deliberately conservative: the full
 * text is one click away under "Why", so a missed split costs a caption a line,
 * never a reader a sentence.
 */
const NON_TERMINAL_ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "cf",
  "vs",
  "no",
  "nos",
  "art",
  "arts",
  "cl",
  "para",
  "paras",
  "sec",
  "secs",
  "approx",
]);

const SENTENCE_END = /[.!?]["'”’)\]]?(?=\s|$)/gu;

/**
 * The first sentence of a caption, which is all the collapsed card shows.
 *
 * Punctuation-based rather than locale-aware `Intl.Segmenter`: the caption is
 * model-written prose whose language follows the document, and a segmenter
 * keyed to the UI locale would be no more right about it. Initials, decimals,
 * and the abbreviations above do not end a sentence.
 */
export const firstSentence = (text: string): string => {
  const trimmed = text.trim();
  for (const match of trimmed.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    if (end >= trimmed.length) {
      break;
    }
    const preceding = trimmed.slice(0, match.index).split(/\s+/u).at(-1) ?? "";
    if (preceding.length <= 1) {
      continue;
    }
    if (NON_TERMINAL_ABBREVIATIONS.has(preceding.toLowerCase())) {
      continue;
    }
    // A decimal ("Net 30.5 days"), not a full stop.
    if (/\d$/u.test(preceding) && /^\d/u.test(trimmed.slice(end))) {
      continue;
    }
    return trimmed.slice(0, end);
  }
  return trimmed;
};

const severityRank = (severity: ReviewFinding["severity"]): number =>
  SEVERITY_ORDER.indexOf(severity);

/**
 * The list a reviewer reads top to bottom: the most severe positions first,
 * then the order the positions were confirmed in. Direction and verdict are
 * not sorted on — the card header's judgment carries those — so the same
 * position keeps the same place across runs.
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

export const SUMMARY_SEPARATOR = " · ";

/** The two phrases a basis sentence does not read out of the run, already in
 *  the reader's language: where the positions came from when no playbook is
 *  named, and the side the run was judged for. */
type RunBasisLabels = {
  /** "positions proposed from the references". */
  proposedFromReferencesLabel: string;
  /** "for the Purchaser", or the phrase for a run judged for no side. */
  sideLabel: string;
};

type RunSummaryArgs = RunBasisLabels & {
  /** The reviewed document's name, or `""` while it is not known yet. */
  targetName: string;
  /** Its version number at the moment the run pinned it, when resolvable. */
  targetVersionNumber: number | null;
  references: readonly ReferenceFile[];
  /** The pinned playbook's name; ignored for a run whose positions were only
   *  ever confirmed for it. */
  playbookName: string;
  playbookProposed: boolean;
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
  proposedFromReferencesLabel,
  sideLabel,
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
      ? proposedFromReferencesLabel
      : playbookName,
  );
  parts.push(sideLabel);
  return parts.join(SUMMARY_SEPARATOR);
};

type RunHistoryBasisArgs = RunBasisLabels & {
  /** The pinned playbook's name, as the list endpoint read it out of the
   *  basis; `null` for a run that pinned no snapshot name. */
  playbookName: string | null;
  playbookProposed: boolean;
  /** `"3 references"`, already formatted in the caller's locale, or `null`
   *  when the run compared against no document. */
  references: string | null;
};

/**
 * What one history row says the run was measured against. The same three facts
 * as the header's summary sentence, minus the target: every row in the list
 * belongs to the same document.
 */
export const buildRunHistoryBasisSentence = ({
  playbookName,
  playbookProposed,
  references,
  proposedFromReferencesLabel,
  sideLabel,
}: RunHistoryBasisArgs): string => {
  const parts: string[] = [];
  if (references !== null) {
    parts.push(references);
  }
  if (!playbookProposed && playbookName !== null && playbookName.length > 0) {
    parts.push(playbookName);
  }
  if (parts.length === 0) {
    parts.push(proposedFromReferencesLabel);
  }
  parts.push(sideLabel);
  return parts.join(SUMMARY_SEPARATOR);
};
