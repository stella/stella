/**
 * Resolving a staged review suggestion resolves the finding behind it.
 *
 * A reviewer accepting a redline in the document panel and a reviewer accepting
 * the finding in the review list are the same act, so they must be one write.
 * The suggestion row is the surface; the finding is the durable judgment, and
 * this is the only place the two are reconciled.
 *
 * Lock order is fixed by both callers: the suggestion row first (its own
 * conditional UPDATE), then the finding. Keeping that order in one module is
 * what stops the accept and revert paths from deadlocking against each other.
 */

import { panic } from "better-result";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { documentReviewFindings } from "@/api/db/schema";
import type { DocxSuggestionStatus } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import {
  DOCUMENT_REVIEW_APPLICATION_STATUS,
  DOCUMENT_REVIEW_DECISION,
} from "@/api/lib/document-review/run-contract";
import type {
  DocumentReviewApplicationStatus,
  DocumentReviewDecision,
} from "@/api/lib/document-review/run-contract";

/** The finding columns one suggestion transition writes. */
type FindingDecisionUpdate = {
  decision: DocumentReviewDecision;
  decidedBy: SafeId<"user"> | null;
  decidedAt: Date | null;
  applicationStatus: DocumentReviewApplicationStatus;
  appliedBy: SafeId<"user"> | null;
  appliedAt: Date | null;
};

type FindingDecisionUpdateArgs = {
  status: DocxSuggestionStatus;
  userId: SafeId<"user">;
  now: Date;
};

/**
 * What each suggestion status means for the finding, stated once and totally
 * over the suggestion vocabulary.
 *
 * Accepting is both halves at once — the reviewer took the decision and the
 * tracked change went into the draft — which is exactly why the two rows must
 * move together. Rejecting is a dismissal that changes nothing in the document.
 * Reverting withdraws both, leaving the finding as the engine produced it.
 */
const findingDecisionUpdate = ({
  status,
  userId,
  now,
}: FindingDecisionUpdateArgs): FindingDecisionUpdate => {
  switch (status) {
    case "accepted":
      return {
        decision: DOCUMENT_REVIEW_DECISION.ACCEPTED,
        decidedBy: userId,
        decidedAt: now,
        applicationStatus: DOCUMENT_REVIEW_APPLICATION_STATUS.APPLIED,
        appliedBy: userId,
        appliedAt: now,
      };
    case "rejected":
      return {
        decision: DOCUMENT_REVIEW_DECISION.DISMISSED,
        decidedBy: userId,
        decidedAt: now,
        applicationStatus: DOCUMENT_REVIEW_APPLICATION_STATUS.PENDING,
        appliedBy: null,
        appliedAt: null,
      };
    case "pending":
      return {
        decision: DOCUMENT_REVIEW_DECISION.OPEN,
        decidedBy: null,
        decidedAt: null,
        applicationStatus: DOCUMENT_REVIEW_APPLICATION_STATUS.PENDING,
        appliedBy: null,
        appliedAt: null,
      };
    default:
      status satisfies never;
      return panic("Unhandled docx suggestion status");
  }
};

export type SyncReviewFindingForSuggestionArgs = {
  tx: Transaction;
  workspaceId: SafeId<"workspace">;
  findingId: SafeId<"documentReviewFinding">;
  /** The status the suggestion row just moved to. */
  status: DocxSuggestionStatus;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
};

/**
 * Move the linked finding to match a suggestion's new status, in the caller's
 * transaction. A finding that no longer exists (or that the caller's scope
 * cannot see) syncs nothing: the link is `ON DELETE SET NULL`, so an orphaned
 * suggestion is a state the schema allows.
 */
export const syncReviewFindingForSuggestion = async ({
  tx,
  workspaceId,
  findingId,
  status,
  userId,
  recordAuditEvent,
}: SyncReviewFindingForSuggestionArgs): Promise<void> => {
  const rows = await tx
    .select({
      runId: documentReviewFindings.runId,
      positionId: documentReviewFindings.positionId,
      decision: documentReviewFindings.decision,
      applicationStatus: documentReviewFindings.applicationStatus,
    })
    .from(documentReviewFindings)
    .where(
      and(
        eq(documentReviewFindings.id, findingId),
        eq(documentReviewFindings.workspaceId, workspaceId),
      ),
    )
    .limit(1)
    .for("update");
  const finding = rows.at(0);
  if (finding === undefined) {
    return;
  }

  const update = findingDecisionUpdate({ status, userId, now: new Date() });
  await tx
    .update(documentReviewFindings)
    .set(update)
    .where(
      and(
        eq(documentReviewFindings.id, findingId),
        eq(documentReviewFindings.workspaceId, workspaceId),
      ),
    );

  // The same audit shape `PATCH /findings/:id` writes: one reviewer decision
  // must read the same way in the log whichever surface it was taken on.
  await recordAuditEvent(tx, {
    action: AUDIT_ACTION.REVIEW,
    resourceType: AUDIT_RESOURCE_TYPE.DOCUMENT_REVIEW_RUN,
    resourceId: finding.runId,
    changes: {
      decision: { old: finding.decision, new: update.decision },
      applicationStatus: {
        old: finding.applicationStatus,
        new: update.applicationStatus,
      },
    },
    metadata: {
      findingId,
      positionId: finding.positionId,
      suggestionStatus: status,
    },
  });
};
