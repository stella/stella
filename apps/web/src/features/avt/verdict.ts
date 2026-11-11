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
import { REVIEW_STATUS_META } from "@/features/avt/types";
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

/** A claim is SETTLED once a human dispositions it either way; marking it
 *  as needing evidence keeps it open. */
export const isSettled = (review: ClaimReview | null): boolean => {
  const status = review?.status ?? null;
  return status !== null && REVIEW_STATUS_META[status].settles;
};

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
    // Missing coverage has no conflict to suggest a record for.
    suggestedGoverningFactId: null,
    text: claim.text,
    anchor: claim.anchor,
    refs: [],
    review: claim.review,
    recheck: claim.recheck,
  };
};

export type DispositionTone =
  "ready" | "manual" | "escalate" | "gap" | "routine";

/** The badge each tone shows. A gap shows none: its next steps are the
 *  guide, and its one line says what is missing. */
const GUIDANCE_KEYS = {
  ready: "avt.guidance.readyToConfirm",
  manual: "avt.guidance.manualJudgement",
  escalate: "avt.guidance.escalate",
  gap: null,
  routine: "avt.guidance.optional",
} as const satisfies Record<DispositionTone, TranslationKey | null>;

type DispositionGuideKey = NonNullable<
  (typeof GUIDANCE_KEYS)[keyof typeof GUIDANCE_KEYS]
>;

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
  "testimony-only": "avt.disposition.testimonyOnly",
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

/** What signing off a supported claim confirms, naming its footing when
 *  that is testimony or no source at all. */
const supportedAsk = (claim: Pick<TriageTarget, "qualifiers">) => {
  if (hasQualifier(claim, "testimony-only")) {
    return QUALIFIER_ASK["testimony-only"];
  }
  if (hasQualifier(claim, "unsourced-only")) {
    return QUALIFIER_ASK["unsourced-only"];
  }
  return DISPOSITION_COPY.supported;
};

export type DispositionGuidance = {
  tone: DispositionTone;
  guideKey: DispositionGuideKey | null;
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
    // A person's account and knowledge without a source are both allowed;
    // the sign-off copy discloses which the verdict rests on.
    return {
      tone: "ready",
      guideKey: GUIDANCE_KEYS.ready,
      askKey: supportedAsk(claim),
    };
  }
  if (claim.state === "nocover" && hasQualifier(claim, "record-silent")) {
    return {
      tone: "routine",
      guideKey: GUIDANCE_KEYS.routine,
      askKey: QUALIFIER_ASK["record-silent"],
    };
  }
  // Missing coverage the record should have is a gap to fill, not a
  // verdict to sign off: its next steps are adding or linking a fact.
  if (claim.state === "nocover") {
    return {
      tone: "gap",
      guideKey: GUIDANCE_KEYS.gap,
      askKey: DISPOSITION_COPY.nocover,
    };
  }
  return {
    tone: "routine",
    guideKey: GUIDANCE_KEYS.routine,
    askKey: DISPOSITION_COPY[claim.state],
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
  needsEvidence: number;
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
  let needsEvidence = 0;

  for (const rawClaim of claims) {
    // Count the claim as it is displayed: reopening reclassifies a claim to
    // `nocover` with no refs, so the raw claim would be tallied under its
    // original state and judged on refs it no longer has.
    const claim = resolveClaimView(rawClaim);
    const state = effectiveState(claim, claim.review);
    byState[state] += 1;
    if (claim.review?.status === "needs-evidence") {
      needsEvidence += 1;
    }
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
    needsEvidence,
    byState,
    attnTotal,
    attnSettled,
    attnOpen: attnTotal - attnSettled,
    routineTotal: claims.length - attnTotal,
    routineUnsettled,
  };
};

/** Routine claims with no status yet: what "accept routine" marks. A claim
 *  someone marked as needing evidence is left for them, as the server does. */
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
        ) && (claim.review?.status ?? null) === null,
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
const evidenceFactsById = (
  run: Pick<VerificationRun, "evidence" | "factStandings">,
): ReadonlyMap<FactId, ShownFact> => {
  const standings = new Map(
    run.factStandings.map(({ factEntityId, scoring, tier }) => [
      factEntityId,
      { scoring, tier },
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

/**
 * The facts a claim's detail can name: the run's pinned facts, with the
 * facts its latest re-check read in their place (a fact added after the run
 * is known only from the re-check).
 */
export const claimFactsById = (
  run: Pick<VerificationRun, "evidence" | "factStandings">,
  claim: Pick<VerificationClaim, "recheck">,
): ReadonlyMap<FactId, ShownFact> => {
  const facts = new Map(evidenceFactsById(run));
  if (claim.recheck === null) {
    return facts;
  }
  const standings = new Map(
    run.factStandings.map(({ factEntityId, scoring, tier }) => [
      factEntityId,
      { scoring, tier },
    ]),
  );
  for (const fact of claim.recheck.facts) {
    facts.set(fact.factEntityId, {
      ...fact,
      standing:
        standings.get(fact.factEntityId) ??
        panic("A re-checked fact has no standing in the run read"),
    });
  }
  return facts;
};
