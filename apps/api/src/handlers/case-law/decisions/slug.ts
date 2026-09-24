import { fitCaseLawDecisionSlug } from "@stll/api-contract/case-law-decision-route";

const CASE_LAW_DECISION_SLUG_HASH_LENGTH = 16;
export const CASE_LAW_DECISION_SLUG_ALLOCATION_ATTEMPTS = [
  0, 1, 2, 3, 4,
] as const;
type CaseLawDecisionSlugAllocationAttempt =
  (typeof CASE_LAW_DECISION_SLUG_ALLOCATION_ATTEMPTS)[number];

type CaseLawDecisionSlugCandidateOptions = {
  baseSlug: string;
  /** Stable allocation identity: publisher identity or a persisted row id. */
  identity: string;
  attempt: CaseLawDecisionSlugAllocationAttempt;
};

/**
 * Candidate zero preserves the existing public URL shape. On a collision, a
 * deterministic identity digest makes overlapping ingestion and a replay pick
 * the same next candidate without reading the global slug namespace.
 */
export const createCaseLawDecisionSlugCandidate = ({
  baseSlug,
  identity,
  attempt,
}: CaseLawDecisionSlugCandidateOptions): string => {
  if (attempt === 0) {
    return fitCaseLawDecisionSlug({ baseSlug });
  }

  const digest = new Bun.CryptoHasher("sha256")
    .update(`${identity}\u0000${attempt}`)
    .digest("hex")
    .slice(0, CASE_LAW_DECISION_SLUG_HASH_LENGTH);
  return fitCaseLawDecisionSlug({ baseSlug, suffix: `-${digest}` });
};
