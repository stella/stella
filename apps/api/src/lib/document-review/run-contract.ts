// Durable document-review run vocabulary and pinned-basis shapes.
//
// This module is deliberately dependency-light: the database schema
// (`db/schema/document-reviews.ts`) derives its CHECK constraint enums from the
// consts here, and only the type-level shapes reach in from the AI engine
// modules (erased at build time). Nothing here imports a handler slice, so the
// background worker and the endpoints share one definition of what a run is.

import {
  DOCUMENT_REVIEW_LIMITS,
  REVIEW_FLAGS,
  REVIEW_FLAGS_MAX_ITEMS,
} from "@stll/api-contract";
import type { ReviewFlag } from "@stll/api-contract";

import type { SafeId } from "@/api/lib/branded-types";
import type { ConstantMap } from "@/api/lib/constant-map";
import type { ReviewPerspective } from "@/api/lib/document-review/contract";
import type { ReviewFinding } from "@/api/lib/document-review/review-grade";
import type { PlaybookPositions } from "@/api/lib/workflow/playbook-positions";
import { VERDICT_TIERS } from "@/api/lib/workflow/verdict-tiers";

/** Lifecycle of one review execution. `queued` on insert, `running` once the
 *  worker claims it, then a terminal `completed` / `failed` / `cancelled`. */
export const DOCUMENT_REVIEW_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type DocumentReviewRunStatus =
  (typeof DOCUMENT_REVIEW_RUN_STATUSES)[number];

/** The statuses that still occupy a document: exactly one run may hold them
 *  per `(entityId, fileFieldId)`, enforced by a partial unique index. */
export const DOCUMENT_REVIEW_RUN_ACTIVE_STATUSES = [
  "queued",
  "running",
] as const satisfies readonly DocumentReviewRunStatus[];

/**
 * What drives a run to completion.
 *
 * `worker` is the document-review queue: it claims the run, executes both
 * passes, and finalizes it. `table` is the files-table property DAG: the run is
 * created already claimed, and the verdict batches that grade the document
 * commit its findings as they go.
 *
 * The two must never write into each other's runs — a document holds at most
 * one active run, so without this discriminator the table path could commit
 * into a review a person started from the inspector, and vice versa.
 */
export const DOCUMENT_REVIEW_RUN_EXECUTORS = ["worker", "table"] as const;
export type DocumentReviewRunExecutor =
  (typeof DOCUMENT_REVIEW_RUN_EXECUTORS)[number];
export const DOCUMENT_REVIEW_RUN_EXECUTOR = {
  WORKER: "worker",
  TABLE: "table",
} as const satisfies ConstantMap<DocumentReviewRunExecutor>;

/** Why a run ended in `failed`. A closed set so the surface can explain the
 *  failure without parsing a message, and so no free-form model or provider
 *  text ever lands on the row. */
export const DOCUMENT_REVIEW_RUN_ERROR_CODES = [
  /** A pinned document version or file field no longer resolves. */
  "pin_unresolved",
  /** The pinned file's content hash no longer matches the pin. */
  "pin_content_changed",
  /** A pinned document is not in a format the review engine reads. */
  "unsupported_format",
  /** No model is configured or usage is unavailable for this organization. */
  "ai_unavailable",
  /** The extraction or grading pass failed. */
  "playbook_check_failed",
  /** The reference comparison pass failed. */
  "reference_check_failed",
  /** The job could not be handed to the queue. */
  "enqueue_failed",
  /** Anything the worker could not attribute more precisely. */
  "internal",
] as const;
export type DocumentReviewRunErrorCode =
  (typeof DOCUMENT_REVIEW_RUN_ERROR_CODES)[number];

/** The most finding rows one run can hold: one per confirmed position.
 *  Derived from the cap the create endpoint enforces, so every bounded read
 *  over a run's findings moves with that cap instead of restating it. */
export const DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX =
  DOCUMENT_REVIEW_LIMITS.positionsMax;

/** The outcome vocabulary a finding row's CHECK constraint accepts. One
 *  vocabulary for every finding: a reference comparison and a tier match are
 *  two ways of reaching the same judgment, not two kinds of judgment. */
export const DOCUMENT_REVIEW_OUTCOMES = VERDICT_TIERS;

/**
 * What a reviewer decided about one finding. A named disposition rather than
 * an `isAccepted` flag: the set grows (deferred, escalated, waived) and each
 * addition must force a decision at every site that reads it.
 *
 * `open` is the state a finding is born in, and the only one that carries no
 * decider: the schema enforces `decision = 'open'` exactly when `decided_at`
 * is null, so "decided" cannot drift from "has a decision".
 */
export const DOCUMENT_REVIEW_DECISIONS = [
  "open",
  "accepted",
  "dismissed",
] as const;
export type DocumentReviewDecision = (typeof DOCUMENT_REVIEW_DECISIONS)[number];
export const DOCUMENT_REVIEW_DECISION = {
  OPEN: "open",
  ACCEPTED: "accepted",
  DISMISSED: "dismissed",
} as const satisfies ConstantMap<DocumentReviewDecision>;

/**
 * Reviewer flags a finding carries, alongside its decision.
 *
 * Deliberately the same vocabulary the files table's cell flags use, from the
 * same list: flagging a finding "needs review" and flagging the cell that
 * holds the same document's answer are the same gesture by the same person, so
 * they are the same words. A flag is not a disposition — accept and dismiss
 * stay the tracked-change verbs — and the two are set and read independently.
 */
export const DOCUMENT_REVIEW_FINDING_FLAGS = REVIEW_FLAGS;
export type DocumentReviewFindingFlag = ReviewFlag;

/** How many flags one finding row may carry: the vocabulary's own size, since
 *  flags are a set. Mirrors the cell metadata cap for the same reason. */
export const DOCUMENT_REVIEW_FINDING_FLAGS_MAX = REVIEW_FLAGS_MAX_ITEMS;

/** Whether a proposed fix has been inserted into the draft. Kept apart from
 *  the reviewer's decision: accepting a finding does not itself mutate the
 *  document, while an applied tracked change stays applied if the finding is
 *  later reopened. */
export const DOCUMENT_REVIEW_APPLICATION_STATUSES = [
  "pending",
  "applied",
] as const;
export type DocumentReviewApplicationStatus =
  (typeof DOCUMENT_REVIEW_APPLICATION_STATUSES)[number];
export const DOCUMENT_REVIEW_APPLICATION_STATUS = {
  PENDING: "pending",
  APPLIED: "applied",
} as const satisfies ConstantMap<DocumentReviewApplicationStatus>;

/**
 * Where the pinned playbook came from. `approved` is a snapshot of an approved
 * version, `draft` the live definition an author chose to run, and `ephemeral`
 * a position list confirmed for this run alone and never saved — the case a
 * reviewer lands in when they have a past deal and no written playbook.
 */
export const PLAYBOOK_PIN_PROVENANCES = [
  "approved",
  "draft",
  "ephemeral",
] as const;
export type PlaybookPinProvenance = (typeof PLAYBOOK_PIN_PROVENANCES)[number];
export const PLAYBOOK_PIN_PROVENANCE = {
  APPROVED: "approved",
  DRAFT: "draft",
  EPHEMERAL: "ephemeral",
} as const satisfies ConstantMap<PlaybookPinProvenance>;

/**
 * The playbook a run was executed against, embedded whole. The snapshot is
 * carried even when `versionId` is set so a run stays intelligible after the
 * definition (and its versions) are deleted; there is deliberately no foreign
 * key from a run to a playbook. `definitionId` is null exactly when the
 * provenance is `ephemeral`: there is no definition to point at yet.
 */
export type PinnedPlaybook = {
  definitionId: SafeId<"playbookDefinition"> | null;
  versionId: SafeId<"playbookDefinitionVersion"> | null;
  provenance: PlaybookPinProvenance;
  definitionSnapshot: { name: string; positions: PlaybookPositions };
};

/** One reference document pinned to the exact version it was read from. */
export type PinnedReference = {
  /** The matter the reference lives in; not necessarily the run's own. */
  workspaceId: SafeId<"workspace">;
  /** That matter's name at pin time, so a restored run can say where the
   *  reference came from after the matter is renamed or gone. */
  workspaceName: string;
  entityId: SafeId<"entity">;
  fileFieldId: SafeId<"field">;
  entityVersionId: SafeId<"entityVersion">;
  contentSha256: string;
  name: string;
};

/**
 * What the run was measured against: one position list, the reference
 * documents those positions were derived from (empty for an authored
 * playbook), and the side the run was judged for.
 *
 * Deliberately not a union. A playbook run and a reference run differ in where
 * a position's standard came from, which the position itself already says
 * (`standard.source`); a second discriminator here would put the same fact in
 * two places and force every reader to branch on it.
 */
export type DocumentReviewRunBasis = {
  playbook: PinnedPlaybook;
  references: PinnedReference[];
  perspective: ReviewPerspective;
};

/** The engine result a finding row carries. */
export type DocumentReviewFindingPayload = { finding: ReviewFinding };
