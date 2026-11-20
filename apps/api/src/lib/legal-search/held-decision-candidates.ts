import type { BoundedReadResult } from "@/api/lib/db/read-bounded";

import { HELD_DECISION_MATCH_BASIS } from "./held-decision-attachment-values";

export type HeldDecisionCandidate = { id: string };

type CandidatePaths<TCandidate> = {
  ecli: BoundedReadResult<TCandidate>;
  courtDocketDate: BoundedReadResult<TCandidate>;
};

export type HeldDecisionCandidateSets<TCandidate> = {
  /** Original decision publishers take precedence over collection copies. */
  hosts: CandidatePaths<TCandidate>;
  collections: CandidatePaths<TCandidate>;
};

export type HeldDecisionCandidateResolution<TCandidate> =
  | { status: "absent" }
  | {
      status: "matched";
      basis:
        | typeof HELD_DECISION_MATCH_BASIS.ECLI
        | typeof HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE;
      candidate: TCandidate;
    }
  | {
      status: "conflict";
      ecliCandidates: TCandidate[];
      courtDocketDateCandidates: TCandidate[];
    }
  | {
      status: "ambiguous";
      candidates: TCandidate[];
      completeness: "complete" | "overflow";
    };

const distinctCandidates = <TCandidate extends HeldDecisionCandidate>(
  rows: TCandidate[],
) => [...new Map(rows.map((row) => [row.id, row])).values()];

/**
 * Inputs already name canonical decisions. SQL must collapse retired aliases
 * before applying each bounded read; otherwise aliases can conceal one host
 * behind an overflow sentinel.
 */
const resolvePaths = <TCandidate extends HeldDecisionCandidate>({
  ecli,
  courtDocketDate,
}: CandidatePaths<TCandidate>): HeldDecisionCandidateResolution<TCandidate> => {
  if (ecli.type === "overflow" || courtDocketDate.type === "overflow") {
    return { status: "ambiguous", candidates: [], completeness: "overflow" };
  }
  const ecliRows = distinctCandidates(ecli.rows);
  const tupleRows = distinctCandidates(courtDocketDate.rows);
  const ecliIds = new Set(ecliRows.map(({ id }) => id));
  const tupleIds = new Set(tupleRows.map(({ id }) => id));
  if (
    ecliIds.size > 0 &&
    tupleIds.size > 0 &&
    (ecliIds.size !== tupleIds.size ||
      [...ecliIds].some((id) => !tupleIds.has(id)))
  ) {
    return {
      status: "conflict",
      ecliCandidates: ecliRows,
      courtDocketDateCandidates: tupleRows,
    };
  }
  const candidates = distinctCandidates([...ecliRows, ...tupleRows]);
  const [first, second] = candidates;
  if (first === undefined) {
    return { status: "absent" };
  }
  if (second !== undefined) {
    return {
      status: "ambiguous",
      candidates,
      completeness: "complete",
    };
  }
  return {
    status: "matched",
    basis:
      tupleRows.length > 0
        ? HELD_DECISION_MATCH_BASIS.COURT_DOCKET_DATE
        : HELD_DECISION_MATCH_BASIS.ECLI,
    candidate: first,
  };
};

/** Both identity paths participate; an ECLI hit never bypasses tuple conflicts. */
export const resolveHeldDecisionCandidates = <
  TCandidate extends HeldDecisionCandidate,
>({
  hosts,
  collections,
}: HeldDecisionCandidateSets<TCandidate>): HeldDecisionCandidateResolution<TCandidate> => {
  const host = resolvePaths(hosts);
  return host.status === "absent" ? resolvePaths(collections) : host;
};
