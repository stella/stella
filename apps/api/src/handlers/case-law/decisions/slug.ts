import { stripDiacriticsForSlug } from "@stll/text-normalize";

const CASE_LAW_DECISION_SLUG_MAX_LENGTH = 256;
const CASE_LAW_DECISION_SLUG_HASH_LENGTH = 16;
export const CASE_LAW_DECISION_SLUG_ALLOCATION_ATTEMPTS = [
  0, 1, 2, 3, 4,
] as const;
type CaseLawDecisionSlugAllocationAttempt =
  (typeof CASE_LAW_DECISION_SLUG_ALLOCATION_ATTEMPTS)[number];

const trimSlugHyphens = (value: string): string => {
  let start = 0;
  while (value.at(start) === "-") {
    start += 1;
  }

  let end = value.length;
  while (end > start && value.at(end - 1) === "-") {
    end -= 1;
  }

  return value.slice(start, end);
};

const fitSlug = (baseSlug: string, suffix = ""): string => {
  const maxBaseLength = Math.max(
    0,
    CASE_LAW_DECISION_SLUG_MAX_LENGTH - suffix.length,
  );
  const trimmed = trimSlugHyphens(baseSlug.slice(0, maxBaseLength));
  return `${trimmed || "unknown"}${suffix}`;
};

export const createCaseLawDecisionSlug = (caseNumber: string): string => {
  // NFKD strip is single-homed in stripDiacriticsForSlug; case folding and
  // the [a-z0-9] filter stay here and run in the same order as before, so
  // existing persisted slugs are reproduced byte-for-byte.
  const slug = trimSlugHyphens(
    stripDiacriticsForSlug(caseNumber)
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-"),
  );

  return fitSlug(slug || "unknown");
};

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
    return fitSlug(baseSlug);
  }

  const digest = new Bun.CryptoHasher("sha256")
    .update(`${identity}\u0000${attempt}`)
    .digest("hex")
    .slice(0, CASE_LAW_DECISION_SLUG_HASH_LENGTH);
  return fitSlug(baseSlug, `-${digest}`);
};
