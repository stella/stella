/**
 * AVT verdict and triage logic. No React, no I/O.
 *
 * Which claims warrant a human (conflicts and contested interpretations)
 * versus which are routine (bulk-acceptable, no individual sign-off needed)
 * is the AVT review methodology; the server applies the same rule when it
 * accepts routine claims in bulk.
 */

import { panic } from "better-result";

import type {
  ClaimReview,
  ClaimState,
  EvidenceFact,
  FactId,
  VerificationClaim,
  VerificationRun,
} from "@/features/avt/types";
import type { TranslationKey } from "@/i18n/types";

const CONFLICT_STATES: ReadonlySet<ClaimState> = new Set([
  "contradicted",
  "tension",
  "recordconflict",
]);

export const isConflictState = (state: ClaimState): boolean =>
  CONFLICT_STATES.has(state);

/** Facts of a run's pinned evidence whose meaning is contested. */
export const contestedFactIds = (
  facts: readonly EvidenceFact[],
): ReadonlySet<FactId> =>
  new Set(
    facts
      .filter((fact) => fact.interpretationNote !== null)
      .map((fact) => fact.factEntityId),
  );

type TriageTarget = {
  state: ClaimState;
  refs: VerificationClaim["refs"];
  qualifiers: VerificationClaim["qualifiers"];
};

/** The server decides the review each qualifier asks for; a qualifier that
 *  needs judgement takes the claim out of the routine ones. */
const judgementQualifier = ({ qualifiers }: Pick<TriageTarget, "qualifiers">) =>
  // The server lists computed qualifiers after the grader's and a held
  // footing last, so the last one is the one the reviewer must settle first.
  qualifiers.findLast((qualifier) => qualifier.review === "needs-judgement");

/** True when any fact this claim cites carries an interpretation caveat. */
export const isContested = (
  { refs }: Pick<TriageTarget, "refs">,
  contested: ReadonlySet<FactId>,
): boolean => refs.some((ref) => contested.has(ref.factEntityId));

/**
 * A claim NEEDS ATTENTION if its verdict is a conflict (contradicted, in
 * tension, record conflict), its interpretation is contested, or it carries
 * a qualifier that asks for judgement (a held or differently scoped
 * footing). Everything else is ROUTINE: the per-claim review controls stay
 * available for the record, but it needs no individual sign-off. The server
 * holds bulk acceptance to the same rule.
 */
export const needsAttention = (
  claim: TriageTarget,
  contested: ReadonlySet<FactId>,
): boolean =>
  claim.state !== "notverifiable" &&
  (isConflictState(claim.state) ||
    isContested(claim, contested) ||
    judgementQualifier(claim) !== undefined);

/** A claim is SETTLED once a human dispositions it either way. */
export const isSettled = (review: ClaimReview | null): boolean =>
  review?.status === "reviewed" || review?.status === "disputed";

/**
 * The verdict a reviewer's own decisions lead to. An override stays an
 * annotation beside the tool's verdict; a governed record conflict adopts
 * the verdict attached to the governing record.
 */
export const effectiveState = (
  claim: Pick<VerificationClaim, "verdict">,
  review: ClaimReview | null,
): ClaimState => {
  const { verdict } = claim;
  if (verdict.state !== "recordconflict") {
    return verdict.state;
  }
  const resolution = review?.recordConflictResolution;
  if (resolution?.kind !== "governed") {
    return "recordconflict";
  }
  const index = verdict.recordConflict.factEntityIds.indexOf(
    resolution.factEntityId,
  );
  if (index === -1) {
    return panic(
      `Governing fact ${resolution.factEntityId} is not part of the conflict`,
    );
  }
  return (
    verdict.recordConflict.governingStates.at(index) ??
    panic("A record conflict has fewer verdicts than records")
  );
};

/**
 * Resolve the claim as it should be DISPLAYED.
 *
 * Re-opening a set-aside claim reclassifies it as a checkable fact with no
 * coverage until the document is verified again. A plain override does NOT
 * change this: it is a reviewer annotation shown alongside the tool's
 * verdict, never a replacement for it.
 *
 * Anything deriving state, counts or filtering from a claim resolves through
 * this once and uses the result, so the detail panel, the document, the stat
 * tiles and the filters cannot disagree about the same claim.
 */
export const resolveClaimView = (
  claim: VerificationClaim,
): VerificationClaim => {
  if (
    claim.review?.reopened !== true ||
    claim.verdict.state !== "notverifiable"
  ) {
    return claim;
  }
  return {
    id: claim.id,
    position: claim.position,
    type: "fact",
    framing: claim.framing,
    verdict: { state: "nocover", score: null, recordConflict: null },
    // The server read the claim's qualifiers against the verdict it has
    // until it is checked again, so they are kept unchanged.
    qualifiers: claim.qualifiers,
    text: claim.text,
    anchor: claim.anchor,
    refs: [],
    review: claim.review,
  };
};

export type DispositionTone = "ready" | "manual" | "escalate" | "routine";

const GUIDANCE_KEYS = {
  ready: "avt.guidance.readyToConfirm",
  manual: "avt.guidance.manualJudgement",
  escalate: "avt.guidance.escalate",
  routine: "avt.guidance.optional",
} as const satisfies Record<DispositionTone, TranslationKey>;

type DispositionGuideKey = (typeof GUIDANCE_KEYS)[keyof typeof GUIDANCE_KEYS];

const DISPOSITION_COPY = {
  supported: "avt.disposition.supported",
  tension: "avt.disposition.tension",
  contradicted: "avt.disposition.contradicted",
  recordconflict: "avt.disposition.recordconflict",
  nocover: "avt.disposition.nocover",
  notverifiable: "avt.disposition.notverifiable",
} as const satisfies Record<ClaimState, TranslationKey>;

/** What each qualifier asks of the reviewer, when it is the claim's
 *  deciding caveat. */
const QUALIFIER_ASK = {
  "record-silent": "avt.qualifiers.recordSilent.hint",
  "scope-mismatch": "avt.disposition.scopeMismatch",
  "unsourced-only": "avt.disposition.unsourcedOnly",
  "rests-on-held": "avt.disposition.restsOnHeld",
} as const satisfies Record<
  VerificationClaim["qualifiers"][number]["kind"],
  TranslationKey
>;

type DispositionAskKey =
  | (typeof DISPOSITION_COPY)[keyof typeof DISPOSITION_COPY]
  | (typeof QUALIFIER_ASK)[keyof typeof QUALIFIER_ASK]
  | "avt.disposition.contested";

const hasQualifier = (
  { qualifiers }: Pick<TriageTarget, "qualifiers">,
  kind: keyof typeof QUALIFIER_ASK,
) => qualifiers.some((qualifier) => qualifier.kind === kind);

export type DispositionGuidance = {
  tone: DispositionTone;
  guideKey: DispositionGuideKey;
  askKey: DispositionAskKey;
};

/**
 * State-aware disposition steer: what KIND of call a verdict is asking the
 * reviewer for, not just a generic "review/dispute" pair.
 */
export const dispositionGuidance = (
  claim: TriageTarget,
  contested: ReadonlySet<FactId>,
): DispositionGuidance => {
  if (claim.state === "recordconflict") {
    return {
      tone: "escalate",
      guideKey: GUIDANCE_KEYS.escalate,
      askKey: DISPOSITION_COPY.recordconflict,
    };
  }
  const judgement = judgementQualifier(claim);
  if (judgement !== undefined && claim.state !== "notverifiable") {
    return {
      tone: "manual",
      guideKey: GUIDANCE_KEYS.manual,
      askKey: QUALIFIER_ASK[judgement.kind],
    };
  }
  if (claim.state === "contradicted" || claim.state === "tension") {
    return {
      tone: "manual",
      guideKey: GUIDANCE_KEYS.manual,
      askKey: DISPOSITION_COPY[claim.state],
    };
  }
  if (isContested(claim, contested)) {
    return {
      tone: "manual",
      guideKey: GUIDANCE_KEYS.manual,
      askKey: "avt.disposition.contested",
    };
  }
  if (claim.state === "supported") {
    // Knowledge without a source is allowed; the sign-off copy discloses it.
    return {
      tone: "ready",
      guideKey: GUIDANCE_KEYS.ready,
      askKey: hasQualifier(claim, "unsourced-only")
        ? QUALIFIER_ASK["unsourced-only"]
        : DISPOSITION_COPY.supported,
    };
  }
  return {
    tone: "routine",
    guideKey: GUIDANCE_KEYS.routine,
    askKey:
      claim.state === "nocover" && hasQualifier(claim, "record-silent")
        ? QUALIFIER_ASK["record-silent"]
        : DISPOSITION_COPY[claim.state],
  };
};

const CONFIRM_LABEL_KEYS = {
  supported: "avt.confirm.supported",
  tension: "avt.confirm.verdict",
  contradicted: "avt.confirm.verdict",
  nocover: "avt.confirm.acknowledge",
  recordconflict: "avt.confirm.recordConflict",
  notverifiable: "avt.confirm.acknowledge",
} as const satisfies Record<ClaimState, TranslationKey>;

/** A verdict the reviewer has to weigh is confirmed as a verdict, never as
 *  "ready", whatever its state. */
const CONFIRM_VERDICT_KEY = "avt.confirm.verdict" satisfies TranslationKey;

export const confirmLabel = (state: ClaimState, tone: DispositionTone) =>
  tone === "manual" ? CONFIRM_VERDICT_KEY : CONFIRM_LABEL_KEYS[state];

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
  claims: readonly VerificationClaim[],
  contested: ReadonlySet<FactId>,
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
    // Count the claim as it is displayed: reopening reclassifies a claim to
    // `nocover` with no refs, so the raw claim would be tallied under its
    // original state and judged on refs it no longer has.
    const claim = resolveClaimView(rawClaim);
    const state = effectiveState(claim, claim.review);
    byState[state] += 1;
    const settled = isSettled(claim.review);
    if (
      needsAttention(
        { state, refs: claim.refs, qualifiers: claim.qualifiers },
        contested,
      )
    ) {
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

/** Routine claims nobody has dispositioned yet: what "accept routine" marks. */
export const routineUnsettledClaimIds = (
  claims: readonly VerificationClaim[],
  contested: ReadonlySet<FactId>,
): VerificationClaim["id"][] =>
  claims
    .map(resolveClaimView)
    .filter(
      (claim) =>
        !needsAttention(
          {
            state: effectiveState(claim, claim.review),
            refs: claim.refs,
            qualifiers: claim.qualifiers,
          },
          contested,
        ) && !isSettled(claim.review),
    )
    .map((claim) => claim.id);

type FactStanding = Omit<
  VerificationRun["factStandings"][number],
  "factEntityId"
>;

/** A pinned fact with how it stands on the list now: the footing the
 *  claim's computed qualifiers read. */
export type ShownFact = EvidenceFact & { standing: FactStanding };

/** Pinned evidence facts by id, for the detail panel's fact cards. */
export const evidenceFactsById = (
  run: Pick<VerificationRun, "evidence" | "factStandings">,
): ReadonlyMap<FactId, ShownFact> => {
  const standings = new Map(
    run.factStandings.map(({ factEntityId, scoring, sourcing }) => [
      factEntityId,
      { scoring, sourcing },
    ]),
  );
  return new Map(
    run.evidence.facts.map((fact) => [
      fact.factEntityId,
      {
        ...fact,
        standing:
          standings.get(fact.factEntityId) ??
          panic("A pinned fact has no standing in the run read"),
      },
    ]),
  );
};
