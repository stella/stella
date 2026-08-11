import { Result } from "better-result";

import { DOCUMENT_REVIEW_LIMITS } from "@stll/api-contract";

import type { DocumentReviewTopic } from "@/api/handlers/document-reviews/schemas";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type ProposedReviewTopic = {
  title: string;
  context: string;
};

const normalizeTitle = (value: string): string =>
  value.trim().toLocaleLowerCase("und");

export const validateReviewTopics = (
  topics: readonly DocumentReviewTopic[],
  stage: "proposal" | "comparison",
): Result<void, HandlerError> => {
  if (topics.length > DOCUMENT_REVIEW_LIMITS.topicsMax) {
    return Result.err(
      new HandlerError({ status: 422, message: "Too many review topics." }),
    );
  }
  if (stage === "comparison" && topics.length === 0) {
    return Result.err(
      new HandlerError({
        status: 422,
        message: "At least one confirmed review topic is required.",
      }),
    );
  }
  const topicIds = new Set<string>();
  const positionIds = new Set<string>();
  for (const topic of topics) {
    if (stage === "comparison" && !topic.included) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Comparison topics must be confirmed.",
        }),
      );
    }
    if (topicIds.has(topic.topicId)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Review topic identifiers must be unique.",
        }),
      );
    }
    topicIds.add(topic.topicId);
    if (topic.type !== "playbook") {
      continue;
    }
    if (positionIds.has(topic.positionId)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "Playbook positions must be unique within a review.",
        }),
      );
    }
    positionIds.add(topic.positionId);
  }
  return Result.ok(undefined);
};

export const mergeProposedReviewTopics = (
  seededTopics: readonly DocumentReviewTopic[],
  proposedTopics: readonly ProposedReviewTopic[],
): DocumentReviewTopic[] => {
  const merged = [...seededTopics];
  const seen = new Set(
    seededTopics.map((topic) => normalizeTitle(topic.title)),
  );
  for (const proposed of proposedTopics) {
    if (merged.length >= DOCUMENT_REVIEW_LIMITS.topicsMax) {
      break;
    }
    const title = proposed.title.trim();
    const normalized = normalizeTitle(title);
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push({
      type: "reference",
      topicId: Bun.randomUUIDv7(),
      title,
      context: proposed.context.trim(),
      included: true,
    });
  }
  return merged;
};
