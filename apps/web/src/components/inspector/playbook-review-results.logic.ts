import { panic } from "better-result";

import { REVIEW_DECISION } from "@/components/ai-suggestions/document-review-queries";
import type { DocumentReviewDecision } from "@/components/ai-suggestions/document-review-queries";
import { isDecisionSettled } from "@/components/ai-suggestions/document-review-run.logic";
import type { ReviewFindingDecisionRow } from "@/components/ai-suggestions/document-review-run.logic";
import type {
  PlaybookFinding,
  ReferenceFinding,
  ReviewTopic,
} from "@/components/ai-suggestions/playbook-review-store";
import { isFlaggedPlaybookFinding } from "@/components/inspector/playbook-risk-rollup";

export type ReviewResultItem = {
  id: string;
  title: string;
  playbook: PlaybookFinding | null;
  reference: ReferenceFinding | null;
  /** Every finding row the card stands for: one per check kind that judged
   *  this topic, and what the reviewer decided about each. */
  decisions: readonly ReviewFindingDecisionRow[];
};

type BuildReviewResultItemsArgs = {
  topics: readonly ReviewTopic[];
  playbookFindings: readonly PlaybookFinding[] | null;
  referenceFindings: readonly ReferenceFinding[] | null;
  decisions: readonly ReviewFindingDecisionRow[];
};

const groupDecisionsByTopicId = (
  decisions: readonly ReviewFindingDecisionRow[],
): ReadonlyMap<string, ReviewFindingDecisionRow[]> => {
  const byTopicId = new Map<string, ReviewFindingDecisionRow[]>();
  for (const row of decisions) {
    const existing = byTopicId.get(row.topicId);
    if (existing === undefined) {
      byTopicId.set(row.topicId, [row]);
      continue;
    }
    existing.push(row);
  }
  return byTopicId;
};

const uniqueById = <T>(
  items: readonly T[],
  getId: (item: T) => string,
  source: string,
): ReadonlyMap<string, T> => {
  const byId = new Map<string, T>();
  for (const item of items) {
    const id = getId(item);
    if (byId.has(id)) {
      return panic(`Duplicate ${source} result for review topic ${id}`);
    }
    byId.set(id, item);
  }
  return byId;
};

export const buildReviewResultItems = ({
  topics,
  playbookFindings,
  referenceFindings,
  decisions,
}: BuildReviewResultItemsArgs): ReviewResultItem[] => {
  // `null` findings mean that basis was not part of the run; an empty array
  // means it ran and returned nothing. A basis that never ran gets no index, so
  // the two states stay apart both here and in the reconciliation below.
  const playbookByPositionId =
    playbookFindings === null
      ? null
      : uniqueById(
          playbookFindings,
          (finding) => finding.positionId,
          "playbook",
        );
  const referenceByTopicId =
    referenceFindings === null
      ? null
      : uniqueById(
          referenceFindings,
          (finding) => finding.topicId,
          "reference",
        );
  const decisionsByTopicId = groupDecisionsByTopicId(decisions);
  const consumedPlaybookIds = new Set<string>();
  const consumedReferenceIds = new Set<string>();
  const results: ReviewResultItem[] = [];

  for (const topic of topics) {
    if (!topic.included) {
      continue;
    }
    const playbook =
      topic.type === "playbook" && playbookByPositionId !== null
        ? (playbookByPositionId.get(topic.positionId) ?? null)
        : null;
    const reference =
      referenceByTopicId === null
        ? null
        : (referenceByTopicId.get(topic.topicId) ?? null);
    if (playbook === null && reference === null) {
      return panic(`Review topic ${topic.topicId} has no result`);
    }
    if (playbook !== null) {
      consumedPlaybookIds.add(playbook.positionId);
    }
    if (reference !== null) {
      consumedReferenceIds.add(reference.topicId);
    }
    const topicDecisions = decisionsByTopicId.get(topic.topicId);
    if (topicDecisions === undefined) {
      // Both sides come from the same finding rows, so a topic with a result
      // and no row means the two views of the run disagree.
      return panic(`Review topic ${topic.topicId} has no finding row`);
    }
    results.push({
      id: topic.topicId,
      title: topic.title,
      playbook,
      reference,
      decisions: topicDecisions,
    });
  }

  if (
    playbookByPositionId !== null &&
    consumedPlaybookIds.size !== playbookByPositionId.size
  ) {
    return panic("Playbook review returned a result outside confirmed topics");
  }
  if (
    referenceByTopicId !== null &&
    consumedReferenceIds.size !== referenceByTopicId.size
  ) {
    return panic("Reference review returned a result outside confirmed topics");
  }
  return results;
};

/**
 * The decision a card carries: the one every finding behind it shares, or
 * `open` while any is undecided or the two check kinds were decided
 * differently. A card that does not speak with one voice still needs the
 * reviewer, which is exactly what `open` means here.
 */
export const reviewItemDecision = ({
  decisions,
}: Pick<ReviewResultItem, "decisions">): DocumentReviewDecision => {
  const first = decisions.at(0);
  if (first === undefined) {
    return REVIEW_DECISION.OPEN;
  }
  return decisions.every((row) => row.decision === first.decision)
    ? first.decision
    : REVIEW_DECISION.OPEN;
};

/**
 * Whether the finding itself is one a reviewer has to answer, before any
 * disposition is taken. Kept separate from the decision so the two questions —
 * "is this a problem?" and "has someone dealt with it?" — never merge.
 */
export const isReviewResultActionable = ({
  playbook,
  reference,
}: ReviewResultItem): boolean => {
  if (playbook !== null && isFlaggedPlaybookFinding(playbook)) {
    return true;
  }
  if (reference === null) {
    return false;
  }
  switch (reference.assessment) {
    case "different":
    case "missing-from-target":
    case "additional-in-target":
    case "deal-specific":
      return true;
    case "aligned":
    case "not-comparable":
      return false;
    default:
      reference.assessment satisfies never;
      return false;
  }
};

/**
 * What the "Action needed" filter counts: a flagged finding nobody has
 * disposed of yet. Accepting or dismissing takes the card off the list without
 * changing what the run found.
 */
export const isReviewResultActionNeeded = (item: ReviewResultItem): boolean =>
  !isDecisionSettled(reviewItemDecision(item)) &&
  isReviewResultActionable(item);
