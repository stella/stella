// Durable document-review run vocabulary and pinned-basis shapes.
//
// This module is deliberately dependency-light: the database schema
// (`db/schema/document-reviews.ts`) derives its CHECK constraint enums from the
// consts here, and only the type-level shapes reach in from the AI engine
// modules (erased at build time). Nothing here imports a handler slice, so the
// background worker and the endpoints share one definition of what a run is.

import { DOCUMENT_REVIEW_LIMITS } from "@stll/api-contract";

import type { SafeId } from "@/api/lib/branded-types";
import type { ConstantMap } from "@/api/lib/constant-map";
import { REFERENCE_ASSESSMENTS } from "@/api/lib/document-review/contract";
import type { ReviewPerspective } from "@/api/lib/document-review/contract";
import type { ReferenceReviewFinding } from "@/api/lib/document-review/reference-compare";
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

/** Which executor produced a finding. Kept separate from the outcome so the
 *  two vocabularies are never merged into one. */
export const DOCUMENT_REVIEW_CHECK_KINDS = ["playbook", "reference"] as const;
export type DocumentReviewCheckKind =
  (typeof DOCUMENT_REVIEW_CHECK_KINDS)[number];
export const DOCUMENT_REVIEW_CHECK_KIND = {
  PLAYBOOK: "playbook",
  REFERENCE: "reference",
} as const satisfies ConstantMap<DocumentReviewCheckKind>;

/** The most finding rows one run can hold: one per confirmed topic per check
 *  kind. Derived from the cap the create endpoint enforces, so every bounded
 *  read over a run's findings moves with that cap instead of restating it. */
export const DOCUMENT_REVIEW_FINDINGS_PER_RUN_MAX =
  DOCUMENT_REVIEW_LIMITS.topicsMax * DOCUMENT_REVIEW_CHECK_KINDS.length;

/** Outcome vocabulary per check kind. Total over the kind union by
 *  construction, so a new kind cannot land without a decided vocabulary. */
export const DOCUMENT_REVIEW_OUTCOMES = {
  playbook: VERDICT_TIERS,
  reference: REFERENCE_ASSESSMENTS,
} as const satisfies Record<DocumentReviewCheckKind, readonly string[]>;

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

/** Whether the pinned playbook came from an approved snapshot or from the
 *  live (draft) definition an author chose to run. */
export type PlaybookPinProvenance = "approved" | "draft";

/**
 * The playbook a run was executed against, embedded whole. The snapshot is
 * carried even when `versionId` is set so a run stays intelligible after the
 * definition (and its versions) are deleted; there is deliberately no foreign
 * key from a run to a playbook.
 */
export type PinnedPlaybook = {
  definitionId: SafeId<"playbookDefinition">;
  versionId: SafeId<"playbookDefinitionVersion"> | null;
  provenance: PlaybookPinProvenance;
  definitionSnapshot: { name: string; positions: PlaybookPositions };
};

/** One reference document pinned to the exact version that was compared. */
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

/** What the run was measured against, discriminated exactly like the review
 *  basis the client confirms. */
export type DocumentReviewRunBasis =
  | { type: "playbook"; playbook: PinnedPlaybook }
  | {
      type: "references";
      references: PinnedReference[];
      /** The side the comparison was judged for; pinned so a restored run
       *  reads its impacts the way they were meant. */
      perspective: ReviewPerspective;
    }
  | {
      type: "combined";
      playbook: PinnedPlaybook;
      references: PinnedReference[];
      perspective: ReviewPerspective;
    };

/** The side a run's reference comparison was judged for, or `null` for a
 *  playbook-only run, which compares against nothing. */
export const basisPerspective = (
  basis: DocumentReviewRunBasis,
): ReviewPerspective | null => {
  switch (basis.type) {
    case "references":
    case "combined":
      return basis.perspective;
    case "playbook":
      return null;
    default:
      basis satisfies never;
      return null;
  }
};

/** The basis discriminators the run row's CHECK constraint accepts, derived
 *  from the union so a new basis shape cannot land without the constraint. */
export const DOCUMENT_REVIEW_BASIS_TYPES = [
  "playbook",
  "references",
  "combined",
] as const satisfies readonly DocumentReviewRunBasis["type"][];

/** The engine result a finding row carries, reused verbatim per check kind. */
export type DocumentReviewFindingPayload =
  | { checkKind: "playbook"; finding: ReviewFinding }
  | { checkKind: "reference"; finding: ReferenceReviewFinding };

export const basisPlaybook = (
  basis: DocumentReviewRunBasis,
): PinnedPlaybook | null => {
  switch (basis.type) {
    case "playbook":
    case "combined":
      return basis.playbook;
    case "references":
      return null;
    default:
      return basis satisfies never;
  }
};

/** Shared empty result for a basis that pins no references. A fresh literal
 *  per call would allocate on a hot read path and reads as "not yet known";
 *  this constant means "this basis has none". */
const NO_PINNED_REFERENCES: readonly PinnedReference[] = [];

export const basisReferences = (
  basis: DocumentReviewRunBasis,
): readonly PinnedReference[] => {
  switch (basis.type) {
    case "references":
    case "combined":
      return basis.references;
    case "playbook":
      return NO_PINNED_REFERENCES;
    default:
      return basis satisfies never;
  }
};

/** The stored outcome for a finding. `null` only for an extract-only playbook
 *  position, which yields a value with no verdict. */
export const findingOutcome = (
  payload: DocumentReviewFindingPayload,
): string | null => {
  switch (payload.checkKind) {
    case "playbook":
      return payload.finding.verdict;
    case "reference":
      return payload.finding.assessment;
    default:
      return payload satisfies never;
  }
};
