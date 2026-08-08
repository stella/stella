import { panic } from "better-result";

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
};

type BuildReviewResultItemsArgs = {
  topics: readonly ReviewTopic[];
  playbookFindings: readonly PlaybookFinding[] | null;
  referenceFindings: readonly ReferenceFinding[] | null;
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
}: BuildReviewResultItemsArgs): ReviewResultItem[] => {
  const playbookByPositionId = uniqueById(
    playbookFindings ?? [],
    (finding) => finding.positionId,
    "playbook",
  );
  const referenceByTopicId = uniqueById(
    referenceFindings ?? [],
    (finding) => finding.topicId,
    "reference",
  );
  const consumedPlaybookIds = new Set<string>();
  const consumedReferenceIds = new Set<string>();
  const results: ReviewResultItem[] = [];

  for (const topic of topics) {
    if (!topic.included) {
      continue;
    }
    const playbook =
      topic.type === "playbook"
        ? (playbookByPositionId.get(topic.positionId) ?? null)
        : null;
    const reference = referenceByTopicId.get(topic.topicId) ?? null;
    if (playbook === null && reference === null) {
      return panic(`Review topic ${topic.topicId} has no result`);
    }
    if (playbook !== null) {
      consumedPlaybookIds.add(playbook.positionId);
    }
    if (reference !== null) {
      consumedReferenceIds.add(reference.topicId);
    }
    results.push({
      id: topic.topicId,
      title: topic.title,
      playbook,
      reference,
    });
  }

  if (consumedPlaybookIds.size !== playbookByPositionId.size) {
    return panic("Playbook review returned a result outside confirmed topics");
  }
  if (consumedReferenceIds.size !== referenceByTopicId.size) {
    return panic("Reference review returned a result outside confirmed topics");
  }
  return results;
};

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
