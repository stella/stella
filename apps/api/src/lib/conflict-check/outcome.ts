import type {
  ConflictCheckOutcome,
  ConflictSeverity,
} from "@stll/api-contract/conflict-checks";

import type {
  StoredConflictHit,
  StoredConflictResults,
} from "@/api/lib/conflict-check/stored-results";

const SEVERITY_RANK = {
  potential_conflict: 0,
  needs_review: 1,
  information: 2,
} as const satisfies Record<ConflictSeverity, number>;

/** The more severe of two severities. */
export const moreSevere = (
  left: ConflictSeverity,
  right: ConflictSeverity,
): ConflictSeverity =>
  SEVERITY_RANK[left] <= SEVERITY_RANK[right] ? left : right;

/**
 * A hit's severity is its most severe link. A contact linked to no matter is
 * only in the address book: information.
 */
export const hitSeverity = ({
  links,
}: Pick<StoredConflictHit, "links">): ConflictSeverity => {
  let severity: ConflictSeverity = "information";
  for (const link of links) {
    severity = moreSevere(severity, link.severity);
  }
  return severity;
};

/**
 * The check's outcome, most severe first. A potential conflict outranks
 * everything. Any part of the firm's records left unsearched comes next: the
 * check is `incomplete` and never reads as `no_matches`, however few hits it
 * found in the part it did search.
 */
export const conflictCheckOutcome = (
  results: Pick<StoredConflictResults, "gaps" | "parties">,
): ConflictCheckOutcome => {
  const hits = results.parties.flatMap((party) => party.hits);
  const severities = new Set(hits.map(hitSeverity));
  if (severities.has("potential_conflict")) {
    return "potential_conflict";
  }
  if (
    results.gaps.length > 0 ||
    results.parties.some((party) => party.incomplete)
  ) {
    return "incomplete";
  }
  if (
    severities.has("needs_review") ||
    results.parties.some((party) => party.truncated)
  ) {
    return "needs_review";
  }
  return hits.length > 0 ? "information_only" : "no_matches";
};
