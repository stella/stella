/**
 * AVT — pure verdict/triage logic. No React, no I/O.
 *
 * Ported from the prototype's `verification.jsx` / `detail.jsx`
 * triage model: which claims warrant a human (conflicts + contested
 * interpretations) versus which are routine (bulk-acceptable, no
 * individual sign-off needed). This is Sam's decided methodology —
 * kept verbatim, not redesigned.
 */

import { panic } from "better-result";

import type {
  AnchorFact,
  Claim,
  ClaimReview,
  ClaimState,
} from "@/routes/dev/-components/avt/types";

const CONFLICT_STATES: ReadonlySet<ClaimState> = new Set([
  "contradicted",
  "tension",
  "recordconflict",
]);

const isConflictState = (state: ClaimState): boolean =>
  CONFLICT_STATES.has(state);

/** True when any anchor fact this claim cites carries a genuine interpretation caveat. */
export const isContested = (
  claim: Pick<Claim, "refs">,
  factById: (id: string) => AnchorFact | undefined,
): boolean =>
  claim.refs.some((ref) => factById(ref.factId)?.interpNote !== undefined);

/**
 * A claim NEEDS ATTENTION if its verdict is a conflict (contradicted /
 * in tension / record conflict) OR its interpretation is contested.
 * Everything else — cleanly supported, no coverage, or set aside — is
 * ROUTINE: the per-claim review controls stay available for the audit
 * trail, but it needs no individual sign-off.
 */
export const needsAttention = (
  claim: Pick<Claim, "state" | "refs">,
  factById: (id: string) => AnchorFact | undefined,
): boolean =>
  claim.state !== "notverifiable" &&
  (isConflictState(claim.state) || isContested(claim, factById));

/** A claim is SETTLED once a human dispositions it either way (reviewed OR disputed). */
export const isSettled = (review: ClaimReview | undefined): boolean =>
  review?.status === "reviewed" || review?.status === "disputed";

/**
 * Resolve the analysis verdict. Reviewer overrides remain annotations; a
 * governed record conflict adopts the outcome attached to the selected fact.
 */
export const effectiveState = (
  claim: Pick<Claim, "recordConflict" | "state">,
  review: ClaimReview | undefined,
): ClaimState => {
  if (claim.state !== "recordconflict") {
    return claim.state;
  }
  const resolution = review?.recordConflictResolution;
  if (resolution?.kind !== "governed") {
    return "recordconflict";
  }
  const conflict =
    claim.recordConflict ?? panic("Record-conflict claim has no conflict data");
  const index = conflict.factIds.indexOf(resolution.factId);
  const state = conflict.governingStates.at(index);
  return (
    state ??
    panic(`Governing fact ${resolution.factId} is not part of the conflict`)
  );
};

/**
 * Resolve the claim as it should be DISPLAYED.
 *
 * Re-opening a set-aside claim reclassifies it as a checkable fact and
 * re-scores it — offline in this build, so it always lands on `nocover`
 * with no refs, matching the prototype's own offline fallback.
 *
 * A plain `review.override` deliberately does NOT affect this, matching
 * the prototype's `view()`: an override is a reviewer annotation shown
 * alongside the tool's own verdict (the "Overridden" badge by the
 * Override control), never a replacement for it. Only `reopened`
 * legitimately changes the underlying analysis, because it represents an
 * actual re-classification and re-check rather than a manual override of
 * an existing score.
 *
 * Anything deriving state, counts or filtering from a claim should
 * resolve through this once and use the result, rather than branching on
 * the raw immutable `Claim` — resolving at only some call sites is what
 * previously let the detail panel disagree with the document, the stat
 * tiles and the filters about the same claim.
 */
export const resolveClaimView = (
  claim: Claim,
  review: ClaimReview | undefined,
): Claim => {
  if (review?.reopened && claim.state === "notverifiable") {
    return {
      ...claim,
      type: "fact",
      state: "nocover",
      score: null,
      refs: [],
    };
  }
  return claim;
};

export type DispositionTone = "ready" | "manual" | "escalate" | "routine";

type DispositionGuidance = {
  tone: DispositionTone;
  guide: string;
  ask: string;
};

const DISP_COPY: Record<ClaimState, string> = {
  supported:
    "The record affirms this. Your sign-off confirms the tool read it correctly — no judgement call needed.",
  tension:
    "The record only partly supports this. Weigh the supporting and conflicting facts above before the verdict stands.",
  contradicted:
    "The record departs from this claim. A human call is needed before this verdict stands.",
  recordconflict:
    "Two exhibits in the record disagree. Resolve which governs above, or flag the evidence team — the tool won't pick for you.",
  nocover:
    "No anchor fact addresses this claim, so there's nothing to confirm it against. Sign-off is optional.",
  notverifiable:
    "Set aside as not verifiable — sign-off is optional. Re-open below if it's actually checkable.",
};

/**
 * State-aware disposition steer: what KIND of call a verdict is
 * asking the reviewer for, not just a generic "review/dispute" pair.
 */
export const dispositionGuidance = (
  claim: Pick<Claim, "state" | "refs">,
  factById: (id: string) => AnchorFact | undefined,
): DispositionGuidance => {
  if (claim.state === "recordconflict") {
    return {
      tone: "escalate",
      guide: "Escalate",
      ask: DISP_COPY.recordconflict,
    };
  }
  if (claim.state === "contradicted" || claim.state === "tension") {
    return {
      tone: "manual",
      guide: "Manual judgement",
      ask: DISP_COPY[claim.state],
    };
  }
  if (isContested(claim, factById)) {
    return {
      tone: "manual",
      guide: "Manual judgement",
      ask: "The verdict is clean, but a contributing fact's interpretation is contested — worth your eyes before sign-off.",
    };
  }
  if (claim.state === "supported") {
    return {
      tone: "ready",
      guide: "Ready to confirm",
      ask: DISP_COPY.supported,
    };
  }
  return { tone: "routine", guide: "Optional", ask: DISP_COPY[claim.state] };
};

export const confirmLabel = (state: ClaimState): string => {
  if (state === "supported") {
    return "Confirm — ready";
  }
  if (state === "nocover" || state === "notverifiable") {
    return "Acknowledge";
  }
  if (state === "recordconflict") {
    return "Confirm resolution";
  }
  return "Confirm verdict";
};

type ClaimCounts = {
  total: number;
  byState: Record<ClaimState, number>;
  attnTotal: number;
  attnSettled: number;
  attnOpen: number;
  routineTotal: number;
  routineUnsettled: number;
};

export const countClaims = (
  claims: readonly Claim[],
  reviews: Readonly<Record<string, ClaimReview>>,
  factById: (id: string) => AnchorFact | undefined,
): ClaimCounts => {
  const byState: Record<ClaimState, number> = {
    supported: 0,
    tension: 0,
    contradicted: 0,
    nocover: 0,
    recordconflict: 0,
    notverifiable: 0,
  };
  let attnTotal = 0;
  let attnSettled = 0;
  let routineUnsettled = 0;

  for (const rawClaim of claims) {
    const review = reviews[rawClaim.id];
    // Count the claim as it is currently displayed, not as it was
    // declared: reopening reclassifies a claim to `nocover` with no refs,
    // so counting the raw claim would tally a reopened claim under its
    // original state and judge `needsAttention` on refs it no longer has.
    const claim = resolveClaimView(rawClaim, review);
    const state = effectiveState(claim, review);
    byState[state] += 1;
    const settled = isSettled(review);
    if (needsAttention({ state, refs: claim.refs }, factById)) {
      attnTotal += 1;
      if (settled) {
        attnSettled += 1;
      }
    } else if (!settled) {
      routineUnsettled += 1;
    }
  }

  return {
    total: claims.length,
    byState,
    attnTotal,
    attnSettled,
    attnOpen: attnTotal - attnSettled,
    routineTotal: claims.length - attnTotal,
    routineUnsettled,
  };
};
