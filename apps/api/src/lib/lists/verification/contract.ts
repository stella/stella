// List verification vocabulary: how the claims in a document are checked
// against the facts of a legal list, and how reviewers dispose of them. The
// claim states and review model come from the AVT (Anchor Verification Tool)
// design; any document can be verified against any list of facts.
//
// Dependency-light on purpose: the database schema derives its CHECK enums
// from the consts here, and the handlers and the review fold share one
// definition of a claim and a review event.

import type { SafeId } from "@/api/lib/branded-types";
import type { ConstantMap } from "@/api/lib/constant-map";
import type {
  FactConfidence,
  FactDatePrecision,
} from "@/api/lib/lists/fact-details";
import type { LegalListSourceLocator } from "@/api/lib/lists/types";

export const CLAIM_TYPES = ["fact", "opinion", "unverifiable"] as const;
export type ClaimType = (typeof CLAIM_TYPES)[number];

/** How the author frames a claim. Neutral: never moves state or score. */
export const CLAIM_FRAMINGS = ["asserted", "recalled"] as const;
export type ClaimFraming = (typeof CLAIM_FRAMINGS)[number];

/** States backed by a 0-100 support score computed against the record. */
export const SCORED_CLAIM_STATES = [
  "supported",
  "tension",
  "contradicted",
] as const;
export type ScoredClaimState = (typeof SCORED_CLAIM_STATES)[number];

/** States with no score by definition: nothing to check against, not a
 *  checkable claim, or a verdict withheld until a human picks a record. */
export const UNSCORED_CLAIM_STATES = [
  "nocover",
  "notverifiable",
  "recordconflict",
] as const;

export const CLAIM_STATES = [
  ...SCORED_CLAIM_STATES,
  ...UNSCORED_CLAIM_STATES,
] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

export const CLAIM_STATE = {
  SUPPORTED: "supported",
  TENSION: "tension",
  CONTRADICTED: "contradicted",
  NOCOVER: "nocover",
  NOTVERIFIABLE: "notverifiable",
  RECORDCONFLICT: "recordconflict",
} as const satisfies ConstantMap<ClaimState>;

/** A reviewer override annotates the tool's verdict; a record conflict is
 *  resolved by governing, never overridden. */
export const CLAIM_OVERRIDE_STATES = [
  "supported",
  "tension",
  "contradicted",
  "nocover",
  "notverifiable",
] as const satisfies readonly ClaimState[];
export type ClaimOverrideState = (typeof CLAIM_OVERRIDE_STATES)[number];

export const CLAIM_FACT_RELATIONS = [
  "supports",
  "conflicts",
  "record",
] as const;
export type ClaimFactRelation = (typeof CLAIM_FACT_RELATIONS)[number];

export type ClaimRef = {
  factEntityId: SafeId<"entity">;
  rel: ClaimFactRelation;
};

export const CLAIM_ANCHOR_TYPES = ["docx-block", "pdf-page"] as const;

/** Where a claim sits in the pinned document version. Offsets are UTF-16
 *  code units into the block or page text; the claim's `text` lets a re-parse
 *  re-find the words when offsets no longer line up. */
export type ClaimAnchor =
  | { type: "docx-block"; blockId: string; start: number; end: number }
  | { type: "pdf-page"; pageNumber: number; start: number; end: number };

/** Two anchor facts disagree on the point a claim rests on. Index `i` of
 *  `values` and `governingStates` belongs to `factEntityIds[i]`. */
export type RecordConflict = {
  subject: string;
  factEntityIds: readonly [SafeId<"entity">, SafeId<"entity">];
  values: readonly [string, string];
  governingStates: readonly [ScoredClaimState, ScoredClaimState];
};

/** A claim's verdict: a scored state always carries its 0-100 score, and
 *  only a record conflict carries the two records it is withheld between. */
export type ClaimVerdict =
  | { state: ScoredClaimState; score: number; recordConflict: null }
  | {
      state: "nocover" | "notverifiable";
      score: null;
      recordConflict: null;
    }
  | {
      state: "recordconflict";
      score: null;
      recordConflict: RecordConflict;
    };

/** Lifecycle of one verification run: `queued`, `running`, then terminal. */
export const VERIFICATION_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
] as const;
export type VerificationRunStatus = (typeof VERIFICATION_RUN_STATUSES)[number];

/** Why a run failed. Closed so the read surface can explain each one. */
export const VERIFICATION_RUN_ERROR_CODES = [
  "pin_unresolved",
  "pin_content_changed",
  "unsupported_format",
  "no_text",
  "ai_unavailable",
  "extraction_failed",
  "grading_failed",
  "enqueue_failed",
  "internal",
] as const;
export type VerificationRunErrorCode =
  (typeof VERIFICATION_RUN_ERROR_CODES)[number];

/** At most one run per document may hold these (partial unique index). */
export const VERIFICATION_RUN_ACTIVE_STATUSES = [
  "queued",
  "running",
] as const satisfies readonly VerificationRunStatus[];

export type VerificationEvidenceSource = {
  sourceEntityId: SafeId<"entity">;
  sourceEntityVersionId: SafeId<"entityVersion">;
  locator: LegalListSourceLocator;
  quote: string | null;
};

/** One anchor fact as a run read it. Runs pin the record by value, so a
 *  finished verification stays readable after the list is edited. Detail
 *  fields are null for a fact nobody has described yet. */
export type VerificationEvidenceFact = {
  factEntityId: SafeId<"entity">;
  text: string;
  occurredOn: string | null;
  occurredOnPrecision: FactDatePrecision | null;
  evidenceKind: string | null;
  medium: string | null;
  confidence: FactConfidence | null;
  interpretationNote: string | null;
  sources: readonly VerificationEvidenceSource[];
};

export type VerificationEvidence = {
  listId: SafeId<"legalList">;
  facts: readonly VerificationEvidenceFact[];
};

export const CLAIM_REVIEW_STATUSES = ["reviewed", "disputed"] as const;
export type ClaimReviewStatus = (typeof CLAIM_REVIEW_STATUSES)[number];

/**
 * Reviewer actions, one row each, never rewritten. The current disposition of
 * a claim is the fold of its events (`review-fold.ts`), so "who changed what,
 * when" is always answerable and the projection cannot drift from history.
 */
export const CLAIM_REVIEW_EVENT_KINDS = [
  "status",
  "override",
  "note",
  "reopen",
  "record-conflict",
] as const;
export type ClaimReviewEventKind = (typeof CLAIM_REVIEW_EVENT_KINDS)[number];

/** How a record conflict was resolved: a fact governs (the claim adopts its
 *  verdict), or it went to the evidence team without picking a side. */
export type RecordConflictResolution =
  | { kind: "governed"; factEntityId: SafeId<"entity"> }
  | { kind: "escalated" };

/** `bulk` marks a status set by accepting routine claims in one action. */
export const CLAIM_REVIEW_ORIGINS = ["single", "bulk"] as const;
export type ClaimReviewOrigin = (typeof CLAIM_REVIEW_ORIGINS)[number];

export type ClaimReviewEventPayload =
  | {
      kind: "status";
      status: ClaimReviewStatus | null;
      origin: ClaimReviewOrigin;
    }
  | { kind: "override"; state: ClaimOverrideState | null }
  | { kind: "note"; note: string }
  | { kind: "reopen" }
  | {
      kind: "record-conflict";
      resolution: RecordConflictResolution | null;
    };

export const VERIFICATION_LIMITS = {
  NOTE_MAX: 10_000,
  BULK_CLAIMS_MAX: 500,
  CLAIM_TEXT_MAX: 4000,
  /** The engine writes at most this many claims for one document. */
  CLAIMS_PER_RUN_MAX: 2000,
  /** Reviewer actions one claim may accumulate; bounds a run's review read. */
  REVIEW_EVENTS_PER_CLAIM_MAX: 200,
  /** Facts one run is checked against; every grading call carries them all. */
  FACTS_PER_RUN_MAX: 500,
  /** Sources pinned per fact, oldest first. */
  SOURCES_PER_FACT_MAX: 5,
  /** Characters of a fact's text or a source quote pinned on a run. */
  EVIDENCE_TEXT_MAX: 2000,
} as const;
