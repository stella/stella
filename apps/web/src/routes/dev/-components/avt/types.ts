/**
 * AVT (Anchor Verification Tool) — core domain types.
 *
 * Ported 1:1 from the standalone prototype's data model
 * (`app/data.js`, `app/icons.jsx`, `app/verification.jsx`) — the
 * anchor-fact schema, the claim/scoring shape, and the review-queue
 * states are Sam's investigative-methodology design, not invented
 * here. This file only gives that design real TypeScript types.
 */

export const CONFIDENCE_LEVELS = ["High", "Medium", "Low"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

/**
 * A curated piece of hard evidence (email, bank record, agreed fact,
 * etc.) that claims are checked against. `confidence` is INTERPRETIVE
 * — how unambiguous the evidence's meaning is — and is never derived
 * from `medium` (a neutral carrier descriptor like "Handwritten").
 * `interpNote` is set only where the meaning is genuinely contested;
 * `flag` holds a fact out of scoring pending reviewer confirmation.
 */
export type AnchorFact = {
  id: string;
  fact: string;
  source: string;
  page: string;
  date: string;
  kind: string;
  confidence: ConfidenceLevel;
  period: string;
  medium?: string;
  interpNote?: string;
  flag?: boolean;
  accepted?: boolean;
};

const CLAIM_TYPES = ["fact", "opinion", "unverifiable"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

const CLAIM_STATES = [
  "supported",
  "tension",
  "contradicted",
  "nocover",
  "recordconflict",
  "notverifiable",
] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

/** States backed by a real 0-100 support score, computed against the record. */
const SCORED_CLAIM_STATES = ["supported", "tension", "contradicted"] as const;
type ScoredClaimState = (typeof SCORED_CLAIM_STATES)[number];

/** States with no score by definition — nothing to check against, or the verdict is withheld. */
const UNSCORED_CLAIM_STATES = [
  "nocover",
  "recordconflict",
  "notverifiable",
] as const;
type UnscoredClaimState = (typeof UNSCORED_CLAIM_STATES)[number];

const CLAIM_FACT_RELATIONS = ["supports", "conflicts", "record"] as const;
export type ClaimFactRelation = (typeof CLAIM_FACT_RELATIONS)[number];

type ClaimRef = {
  factId: string;
  rel: ClaimFactRelation;
};

/** A claim withdrawn/revised by a later statement — kept and dated, not deleted. */
type ClaimSupersession = {
  by: string;
  note: string;
  link?: string;
};

export type RecordConflictBoundary = {
  day: number;
  label: string;
  before: { verdict: ClaimState; note: string };
  after: { verdict: ClaimState; note: string };
};

/**
 * Two anchor facts disagree with each other on the same point. The
 * claim's verdict is withheld (never scored) until a human decides
 * which record governs, or flags it for the evidence team.
 */
type RecordConflict = {
  subject: string;
  factIds: readonly [string, string];
  values: readonly [string, string];
  /** Verdict produced when the corresponding record in `factIds` governs. */
  governingStates: readonly [ScoredClaimState, ScoredClaimState];
  kind?: "date";
  dates?: readonly [number, number];
  month?: string;
  boundary?: RecordConflictBoundary;
};

type ClaimBase = {
  id: string;
  type: ClaimType;
  refs: readonly ClaimRef[];
  /** Framed as the witness's own recollection ("I recall..."). Neutral — never affects state/score. */
  recalled?: boolean;
  /** Supporting and conflicting facts cover different dates; reconcile "as at" a chosen date. */
  timeConflict?: boolean;
  superseded?: ClaimSupersession;
};

/**
 * `state` and `score` are a discriminated union, not two independent
 * fields — a scored state always carries a real 0-100 number, an
 * unscored state always carries `null`. This makes the invalid
 * combination (e.g. "supported" with no score) impossible to construct,
 * rather than merely a convention comments ask you to respect.
 */
export type Claim =
  | (ClaimBase & {
      state: ScoredClaimState;
      score: number;
      recordConflict?: never;
    })
  | (ClaimBase & {
      state: Exclude<UnscoredClaimState, "recordconflict">;
      score: null;
      recordConflict?: never;
    })
  | (ClaimBase & {
      state: "recordconflict";
      score: null;
      recordConflict: RecordConflict;
    });

type DocumentSegment = string | { claimId: string };

type DocumentParagraph = {
  id: string;
  segments: readonly DocumentSegment[];
};

export type CaseDocument = {
  title: string;
  meta: string;
  paragraphs: readonly DocumentParagraph[];
};

const REVIEW_STATUSES = ["reviewed", "disputed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type ReviewerOverrideState = Exclude<ClaimState, "recordconflict">;

/**
 * How a human resolved a record conflict: either picked which anchor
 * fact governs (the claim is re-scored against it, the other stays on
 * file marked superseded), or escalated it to the evidence team
 * without picking a side.
 */
export type RecordConflictResolution =
  | { kind: "governed"; factId: string }
  | { kind: "escalated" };

/** Per-claim human-review disposition. Independent of `override` and `note`. */
export type ClaimReview = {
  status: ReviewStatus | null;
  override: ReviewerOverrideState | null;
  note: string;
  savedAt: string | null;
  /** ISO instant of the latest review decision; note timestamps remain separate. */
  decisionAt: string | null;
  /** Set when this claim was cleared via the "accept N routine" bulk action. */
  bulk?: boolean;
  /** Set once a set-aside claim has been re-opened and re-checked against the record. */
  reopened?: boolean;
  recordConflictResolution?: RecordConflictResolution | null;
};

export const EMPTY_REVIEW: ClaimReview = {
  status: null,
  override: null,
  note: "",
  savedAt: null,
  decisionAt: null,
};

type StateMeta = {
  state: ClaimState;
  label: string;
  chip: string;
};

export const STATE_META: Record<ClaimState, StateMeta> = {
  supported: {
    state: "supported",
    label: "Supported by the record",
    chip: "Supported",
  },
  tension: {
    state: "tension",
    label: "In tension with the record",
    chip: "In tension",
  },
  contradicted: {
    state: "contradicted",
    label: "Contradicted by the record",
    chip: "Contradicted",
  },
  nocover: {
    state: "nocover",
    label: "No anchor fact covers this claim",
    chip: "No coverage",
  },
  recordconflict: {
    state: "recordconflict",
    label: "Anchor facts disagree with each other",
    chip: "Record conflict",
  },
  notverifiable: {
    state: "notverifiable",
    label: "Not a checkable factual claim",
    chip: "Not verifiable",
  },
};

type ClaimTypeMeta = {
  type: ClaimType;
  label: string;
  verifiable: boolean;
  hint: string;
};

export const CLAIM_TYPE_META: Record<ClaimType, ClaimTypeMeta> = {
  fact: {
    type: "fact",
    label: "Fact",
    verifiable: true,
    hint: "Objective, checkable assertion — scored against the record. Includes claims framed as admissions or denials: judged on the underlying proposition, not the bare words.",
  },
  opinion: {
    type: "opinion",
    label: "Opinion",
    verifiable: false,
    hint: "A value judgement or characterisation — no document can confirm or contradict it, so it is set aside, not scored.",
  },
  unverifiable: {
    type: "unverifiable",
    label: "Not verifiable",
    verifiable: false,
    hint: "An assertion no document could ever settle — a counterfactual, a prediction, a statement of intent or belief, a legal conclusion, or a claim too vague to check. Set aside, not scored. Distinct from No coverage, which is a checkable fact the record is merely silent on.",
  },
};
