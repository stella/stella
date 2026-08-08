import type { DocumentReviewTopic } from "@/api/handlers/document-reviews/schemas";
import { LIMITS } from "@/api/lib/limits";

type ProposedReviewTopic = {
  title: string;
  context: string;
};

const normalizeTitle = (value: string): string =>
  value.trim().toLocaleLowerCase("und");

export const mergeProposedReviewTopics = (
  seededTopics: readonly DocumentReviewTopic[],
  proposedTopics: readonly ProposedReviewTopic[],
): DocumentReviewTopic[] => {
  const merged = [...seededTopics];
  const seen = new Set(
    seededTopics.map((topic) => normalizeTitle(topic.title)),
  );
  for (const proposed of proposedTopics) {
    if (merged.length >= LIMITS.documentReviewFindingsMax) {
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
