// List verification vocabulary: how the claims in a document are checked
// against the facts of a legal list, and how reviewers dispose of them. The
// claim states and review model come from the AVT (Anchor Verification Tool)
// design; any document can be verified against any list of facts.
//
// Dependency-light on purpose: the database schema derives its CHECK enums
// from the consts here, and the handlers and the review fold share one
// definition of a claim and a review event.

import { panic } from "better-result";

import type { ReviewDecision } from "@stll/api-contract/review-decision";
import type { SpotTarget } from "@stll/api-contract/spot";

import type { SafeId } from "@/api/lib/branded-types";
import type { ConstantMap } from "@/api/lib/constant-map";
import type {
  FactConfidence,
  FactDatePrecision,
} from "@/api/lib/lists/fact-details";
import type { LegalListSourceLocator } from "@/api/lib/lists/types";
import type { GraderClaimQualifier } from "@/api/lib/lists/verification/qualifiers";

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
type ScoredClaimState = (typeof SCORED_CLAIM_STATES)[number];

/** States with no score by definition: nothing to check against, not a
 *  checkable claim, or a verdict withheld until a human picks a record. */
const UNSCORED_CLAIM_STATES = [
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
type ClaimFactRelation = (typeof CLAIM_FACT_RELATIONS)[number];

export type ClaimRef = {
  factEntityId: SafeId<"entity">;
  rel: ClaimFactRelation;
};

export const CLAIM_ANCHOR_TYPES = ["docx-block", "pdf-page"] as const;

/** Where a claim sits in the pinned document version. Offsets are UTF-16
 *  code units into the block or page text; the claim's `text` lets a re-parse
 *  re-find the words when offsets no longer line up. */
export type ClaimAnchor = Extract<
  SpotTarget,
  { type: "docx-block" | "pdf-page"; start: number; end: number }
>;

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
  "access_revoked",
  "run_limit_reached",
  "internal",
] as const;
export type VerificationRunErrorCode =
  (typeof VERIFICATION_RUN_ERROR_CODES)[number];

/**
 * How a run counts the paragraphs of its range: by the numbers the document
 * prints on them (`82.`, `82)`, `[82]`, or Word's own numbering), which is
 * what a lawyer cites, or, in a document that numbers none, by position.
 */
export const PARAGRAPH_NUMBERINGS = ["document", "ordinal"] as const;
export type ParagraphNumbering = (typeof PARAGRAPH_NUMBERINGS)[number];

/** A point in the text a run read: a block by the id the run stores it
 *  under, and a UTF-16 offset into that block's text. */
export type VerificationScopeEdge = { blockId: string; offset: number };

/**
 * What a run checks: the whole document, or an inclusive range of its
 * paragraphs. A range is resolved once, when the run starts, to the text
 * from the start of paragraph `from` to the start of the paragraph after
 * `to` (`start` inclusive, `end` exclusive, in whole-document coordinates).
 * Only claims inside it are extracted and graded.
 */
export type VerificationScope =
  | { kind: "whole" }
  | {
      kind: "paragraphs";
      from: number;
      to: number;
      numbering: ParagraphNumbering;
      start: VerificationScopeEdge;
      end: VerificationScopeEdge;
    };

export const WHOLE_DOCUMENT_SCOPE = {
  kind: "whole",
} as const satisfies VerificationScope;

/** At most one run per document may hold these (partial unique index). */
export const VERIFICATION_RUN_ACTIVE_STATUSES = [
  "queued",
  "running",
] as const satisfies readonly VerificationRunStatus[];

/** 3: grades carry qualifiers (record silent, scope mismatch). */
export const VERIFICATION_PIPELINE_VERSION = 3;

export type VerificationEvidenceSource = {
  sourceEntityId: SafeId<"entity">;
  sourceEntityVersionId: SafeId<"entityVersion">;
  /** The document's name when the run started. Absent on runs pinned before
   *  names were recorded; readers fall back to the document's current name. */
  sourceName?: string;
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

export const CLAIM_REVIEW_STATUSES = [
  "reviewed",
  "disputed",
  "needs-evidence",
] as const;
export type ClaimReviewStatus = (typeof CLAIM_REVIEW_STATUSES)[number];

/** `needs-evidence` keeps a claim open until the record can answer it, so
 *  it decides nothing either way. */
export const AVT_CLAIM_REVIEW_DECISION = {
  reviewed: "accepted",
  disputed: "rejected",
  "needs-evidence": null,
} as const satisfies Record<ClaimReviewStatus, ReviewDecision | null>;

/**
 * Reviewer actions, one row each, never rewritten. The current disposition of
 * a claim is the fold of its events (`review-fold.ts`), so "who changed what,
 * when" is always answerable and the projection cannot drift from history.
 *
 * `fact-link` points the claim at a fact the reviewer says bears on it.
 * `recheck` is a reviewer's request to grade the claim again against the
 * list's facts as they stand, recorded with the grade it got: the claim row
 * keeps the run's own grade, and a re-check never rewrites it.
 */
export const CLAIM_REVIEW_EVENT_KINDS = [
  "status",
  "override",
  "note",
  "reopen",
  "record-conflict",
  "fact-link",
  "recheck",
] as const;
export type ClaimReviewEventKind = (typeof CLAIM_REVIEW_EVENT_KINDS)[number];

const CLAIM_REVIEW_REASON_RULES = ["required", "optional", "none"] as const;
export type ClaimReviewReasonRule = (typeof CLAIM_REVIEW_REASON_RULES)[number];

/**
 * Whether an action carries the reviewer's reason. Actions that change the
 * verdict a claim is read with (an override, a record conflict's resolution,
 * reopening a set-aside claim) require one; a status or a fact link may give
 * one; a note is its own text. A re-check takes none: its grade comes from
 * the facts it pins, not from the reviewer. The payload type, the request
 * schema and the database check all derive from this map.
 */
export const CLAIM_REVIEW_REASON_RULE = {
  status: "optional",
  override: "required",
  note: "none",
  reopen: "required",
  "record-conflict": "required",
  "fact-link": "optional",
  recheck: "none",
} as const satisfies Record<ClaimReviewEventKind, ClaimReviewReasonRule>;

const CLAIM_REVIEW_CARRY_RULES = [
  "always",
  "unchanged-claim",
  "never",
] as const;
export type ClaimReviewCarryRule = (typeof CLAIM_REVIEW_CARRY_RULES)[number];

/**
 * Which reviewer actions on a run follow a claim to the next run of the same
 * document (`carry-over.ts`). A note and a fact link say what the reviewer
 * knows about the claim, so they follow it even when its words were edited.
 * A status, an override, a record conflict's resolution and a reopening were
 * decided on these exact words and the verdict they had, so they follow only
 * to a claim with the same words that the new run gives that same verdict;
 * otherwise they are withdrawn, as a re-check withdraws them. A re-check
 * never follows: the new run is itself a fresh grade.
 */
export const CLAIM_REVIEW_CARRY_RULE = {
  status: "unchanged-claim",
  override: "unchanged-claim",
  note: "always",
  reopen: "unchanged-claim",
  "record-conflict": "unchanged-claim",
  "fact-link": "always",
  recheck: "never",
} as const satisfies Record<ClaimReviewEventKind, ClaimReviewCarryRule>;

/**
 * What became of one claim's review when the next run of its document
 * completed. Only claims with at least one action that can follow are
 * recorded. `carried`: every decision followed; `text-changed`: the matching
 * claim's words were edited, so the decisions taken on the old words were
 * withdrawn; `verdict-changed`: the new run gave the matching claim another
 * verdict, so the decisions taken on the old one were withdrawn (in both,
 * notes and links still followed); `unmatched`: no claim of the new run
 * matches; `ambiguous`: more than one could.
 */
export const CLAIM_CARRY_OUTCOMES = [
  "carried",
  "text-changed",
  "verdict-changed",
  "unmatched",
  "ambiguous",
] as const;
export type ClaimCarryOutcome = (typeof CLAIM_CARRY_OUTCOMES)[number];

/** Outcomes that leave the new run with a matching claim. */
export const MATCHED_CLAIM_CARRY_OUTCOMES = [
  "carried",
  "text-changed",
  "verdict-changed",
] as const satisfies readonly ClaimCarryOutcome[];

/** How a record conflict was resolved: a fact governs (the claim adopts its
 *  verdict), or it went to the evidence team without picking a side. */
export type RecordConflictResolution =
  { kind: "governed"; factEntityId: SafeId<"entity"> } | { kind: "escalated" };

/** Whether a fact link points the claim at the fact or takes that back. */
export const CLAIM_FACT_LINK_CHANGES = ["link", "unlink"] as const;
type ClaimFactLinkChange = (typeof CLAIM_FACT_LINK_CHANGES)[number];

/** A claim's grade: its verdict, the facts it cites, and the grader's
 *  caveats. The run writes one per claim; a re-check records another. */
export type ClaimGrade = ClaimVerdict & {
  refs: ClaimRef[];
  qualifiers: GraderClaimQualifier[];
};

/**
 * The type a graded claim is read with. Extraction sets aside the claims it
 * recognises as untestable, but the grader can still find that one taken for
 * a fact cannot be tested; that claim is unverifiable, the only type the
 * state may carry.
 */
export const gradedClaimType = (grade: ClaimGrade): ClaimType =>
  grade.state === "notverifiable" ? "unverifiable" : "fact";

/** `bulk` marks a status set by accepting routine claims in one action. */
const CLAIM_REVIEW_ORIGINS = ["single", "bulk"] as const;
export type ClaimReviewOrigin = (typeof CLAIM_REVIEW_ORIGINS)[number];

/** What a reviewer did, without why: the part the review fold reads. */
export type ClaimReviewAction =
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
      /** The record the system suggested should govern when the reviewer
       *  acted, so history shows suggestion beside choice; null when it
       *  suggested none. Absent on events recorded before suggestions
       *  existed, when nothing was suggested either. */
      suggestedFactEntityId?: SafeId<"entity"> | null;
    }
  | {
      kind: "fact-link";
      factEntityId: SafeId<"entity">;
      change: ClaimFactLinkChange;
    }
  | {
      kind: "recheck";
      /** The key the request was sent with; a repeat returns this event. */
      requestKey: string;
      grade: ClaimGrade;
      /** The facts the grade was read against, as their difference from
       *  the facts the run pinned (`applyFactChanges`). */
      facts: RecheckFactChanges;
      modelRef: string | null;
    };

/**
 * A re-check's facts stated against its run's pinned facts: each fact that
 * is new or reads differently, and each pinned fact no longer counted. The
 * run's facts with these applied are exactly the facts the grader read, so
 * the event pins its evidence without repeating what the run already holds.
 */
export type RecheckFactChanges = {
  changed: VerificationEvidenceFact[];
  removed: SafeId<"entity">[];
};

/** A reason is trimmed and 1..`NOTE_MAX` characters long. */
type ReasonFields = {
  required: { reason: string };
  optional: { reason?: string };
  none: { reason?: never };
};

type WithReason<Action extends ClaimReviewAction> = Action extends unknown
  ? Action & ReasonFields[(typeof CLAIM_REVIEW_REASON_RULE)[Action["kind"]]]
  : never;

/** One reviewer action as it is recorded now. */
export type ClaimReviewEventPayload = WithReason<ClaimReviewAction>;

/**
 * One reviewer action as stored. Events recorded before reasons were
 * required (migration 20261111120000_legal_list_claim_review_reasons) carry
 * none; they stay as written, since events are never rewritten, and read back
 * as `unrecorded` (`reviewReasonOf`).
 */
export type StoredClaimReviewEventPayload = ClaimReviewAction & {
  reason?: string;
};

/** Why a reviewer acted, as history reads it: the reason given, none (the
 *  action takes none, or an optional one was left out), or none recorded
 *  because the action predates required reasons. */
export type ClaimReviewReason =
  { type: "given"; text: string } | { type: "none" } | { type: "unrecorded" };

export const reviewReasonOf = (
  payload: StoredClaimReviewEventPayload,
): ClaimReviewReason => {
  if (payload.reason !== undefined) {
    return { type: "given", text: payload.reason };
  }
  const rule = CLAIM_REVIEW_REASON_RULE[payload.kind];
  switch (rule) {
    case "required": {
      return { type: "unrecorded" };
    }
    case "optional":
    case "none": {
      return { type: "none" };
    }
    default: {
      rule satisfies never;
      return panic(`Unhandled reason rule: ${String(rule)}`);
    }
  }
};

export const VERIFICATION_LIMITS = {
  NOTE_MAX: 10_000,
  /** Characters of the key a re-check request is repeated under. */
  REQUEST_KEY_MAX: 128,
  BULK_CLAIMS_MAX: 500,
  CLAIM_TEXT_MAX: 4000,
  /** The engine writes at most this many claims for one document. */
  CLAIMS_PER_RUN_MAX: 2000,
  /** Persisted text blocks one run may contain; ordinal fits a smallint. */
  BLOCKS_PER_RUN_MAX: 32_767,
  /** Reviewer actions one claim may accumulate; bounds a run's review read. */
  REVIEW_EVENTS_PER_CLAIM_MAX: 200,
  /** Events one page of review history names. */
  HISTORY_PAGE_MAX: 100,
  /** Reviewers a run's history names for its reviewer filter. */
  HISTORY_REVIEWERS_MAX: 200,
  /** Facts one run is checked against; every grading call carries them all. */
  FACTS_PER_RUN_MAX: 500,
  /** Sources pinned per fact, oldest first. */
  SOURCES_PER_FACT_MAX: 5,
  /** Documents one latest-verification read may name. */
  LATEST_READ_DOCUMENTS_MAX: 200,
  /** Characters of a fact's text, a source quote or a source's document
   *  name pinned on a run. */
  EVIDENCE_TEXT_MAX: 2000,
} as const;
