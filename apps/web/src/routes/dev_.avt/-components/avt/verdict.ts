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

import type { TranslationKey } from "@/i18n/types";
import type {
  AnchorFact,
  Claim,
  ClaimReview,
  ClaimState,
} from "@/routes/dev_.avt/-components/avt/types";

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

const GUIDANCE_KEYS = {
  ready: "avt.guidance.readyToConfirm",
  manual: "avt.guidance.manualJudgement",
  escalate: "avt.guidance.escalate",
  routine: "avt.guidance.optional",
} as const satisfies Record<DispositionTone, TranslationKey>;

type DispositionGuideKey = (typeof GUIDANCE_KEYS)[keyof typeof GUIDANCE_KEYS];

export type DispositionGuidance = {
  tone: DispositionTone;
  guideKey: DispositionGuideKey;
  askKey: DispositionAskKey;
};

const DISP_COPY = {
  supported: "avt.disposition.supported",
  tension: "avt.disposition.tension",
  contradicted: "avt.disposition.contradicted",
  recordconflict: "avt.disposition.recordconflict",
  nocover: "avt.disposition.nocover",
  notverifiable: "avt.disposition.notverifiable",
} as const satisfies Record<ClaimState, TranslationKey>;

type DispositionAskKey =
  | (typeof DISP_COPY)[keyof typeof DISP_COPY]
  | "avt.disposition.contested";

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
      guideKey: GUIDANCE_KEYS.escalate,
      askKey: DISP_COPY.recordconflict,
    };
  }
  if (claim.state === "contradicted" || claim.state === "tension") {
    return {
      tone: "manual",
      guideKey: GUIDANCE_KEYS.manual,
      askKey: DISP_COPY[claim.state],
    };
  }
  if (isContested(claim, factById)) {
    return {
      tone: "manual",
      guideKey: GUIDANCE_KEYS.manual,
      askKey: "avt.disposition.contested",
    };
  }
  if (claim.state === "supported") {
    return {
      tone: "ready",
      guideKey: GUIDANCE_KEYS.ready,
      askKey: DISP_COPY.supported,
    };
  }
  return {
    tone: "routine",
    guideKey: GUIDANCE_KEYS.routine,
    askKey: DISP_COPY[claim.state],
  };
};

const CONFIRM_LABEL_KEYS = {
  supported: "avt.confirm.supported",
  tension: "avt.confirm.verdict",
  contradicted: "avt.confirm.verdict",
  nocover: "tasks.acknowledge",
  recordconflict: "avt.confirm.recordConflict",
  notverifiable: "tasks.acknowledge",
} as const satisfies Record<ClaimState, TranslationKey>;

export const confirmLabel = (state: ClaimState) => CONFIRM_LABEL_KEYS[state];

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
