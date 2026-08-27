/**
 * Record what a reviewer decided about one finding.
 *
 * The decision is the reviewer's, so it is written with their identity and the
 * moment they took it; reopening a finding withdraws both, leaving no decider
 * attached to an undecided row. The database enforces that pairing, so this
 * handler cannot leave the two halves inconsistent.
 */

import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { documentReviewFindings } from "@/api/db/schema";
import { decideReviewFindingBodySchema } from "@/api/handlers/document-reviews/schemas";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import {
  DOCUMENT_REVIEW_APPLICATION_STATUS,
  DOCUMENT_REVIEW_DECISION,
} from "@/api/lib/document-review/run-contract";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Record a reviewer's decision on one review finding and, when requested, the durable application of its proposed edit.",
  // entity:update because deciding a finding can durably apply its proposed
  // edit to the reviewed document; workspace:read alone would let a member
  // with no document-processing grant record and apply review decisions.
  permissions: { workspace: ["read"], entity: ["update"] },
  // A disposition is a durable judgment on the workspace's review record, so
  // it must never be reachable through a read-only consent even though the
  // permission gate fronting the review surface is a workspace read.
  access: "write",
  mcp: { type: "internal", reason: "document_processing" },
  params: workspaceParams({ findingId: tSafeId("documentReviewFinding") }),
  body: decideReviewFindingBodySchema,
} satisfies HandlerConfig;

const decideDocumentReviewFinding = createSafeHandler(
  config,
  async function* ({
    body,
    params,
    recordAuditEvent,
    safeDb,
    user,
    workspaceId,
  }) {
    const { applicationStatus, decision } = body;
    const recordsApplication =
      applicationStatus === DOCUMENT_REVIEW_APPLICATION_STATUS.APPLIED;
    const reopening = decision === DOCUMENT_REVIEW_DECISION.OPEN;
    const now = new Date();
    const decidedAt = reopening ? null : now;
    const decidedBy = reopening ? null : user.id;

    const decided = yield* Result.await(
      safeDb(async (tx) => {
        // Read first for the audit diff, and for the 404: a finding in another
        // workspace is indistinguishable from one that does not exist.
        const rows = await tx
          .select({
            runId: documentReviewFindings.runId,
            topicId: documentReviewFindings.topicId,
            checkKind: documentReviewFindings.checkKind,
            payload: documentReviewFindings.payload,
            decision: documentReviewFindings.decision,
            decidedBy: documentReviewFindings.decidedBy,
            decidedAt: documentReviewFindings.decidedAt,
            applicationStatus: documentReviewFindings.applicationStatus,
            appliedBy: documentReviewFindings.appliedBy,
            appliedAt: documentReviewFindings.appliedAt,
          })
          .from(documentReviewFindings)
          .where(
            and(
              eq(documentReviewFindings.id, params.findingId),
              eq(documentReviewFindings.workspaceId, workspaceId),
            ),
          )
          .limit(1)
          .for("update");
        const finding = rows.at(0);
        if (finding === undefined) {
          return { type: "not-found" } as const;
        }
        if (recordsApplication && finding.payload.finding.fix === null) {
          return { type: "no-fix" } as const;
        }
        if (
          recordsApplication &&
          finding.applicationStatus ===
            DOCUMENT_REVIEW_APPLICATION_STATUS.APPLIED &&
          finding.decision === decision
        ) {
          return { type: "unchanged", finding } as const;
        }

        const appliedAt =
          finding.applicationStatus ===
          DOCUMENT_REVIEW_APPLICATION_STATUS.APPLIED
            ? finding.appliedAt
            : now;
        const appliedBy =
          finding.applicationStatus ===
          DOCUMENT_REVIEW_APPLICATION_STATUS.APPLIED
            ? finding.appliedBy
            : user.id;
        const update = tx
          .update(documentReviewFindings)
          .set(
            recordsApplication
              ? {
                  decision,
                  decidedBy,
                  decidedAt,
                  applicationStatus: DOCUMENT_REVIEW_APPLICATION_STATUS.APPLIED,
                  appliedBy,
                  appliedAt,
                }
              : { decision, decidedBy, decidedAt },
          )
          .where(
            and(
              eq(documentReviewFindings.id, params.findingId),
              eq(documentReviewFindings.workspaceId, workspaceId),
            ),
          );
        await update;

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.REVIEW,
          // A finding is addressed through the run that produced it, so the
          // decision is audited against that run rather than introducing a
          // second resource noun for a subresource.
          resourceType: AUDIT_RESOURCE_TYPE.DOCUMENT_REVIEW_RUN,
          resourceId: finding.runId,
          changes: recordsApplication
            ? {
                decision: { old: finding.decision, new: decision },
                applicationStatus: {
                  old: finding.applicationStatus,
                  new: DOCUMENT_REVIEW_APPLICATION_STATUS.APPLIED,
                },
              }
            : { decision: { old: finding.decision, new: decision } },
          metadata: {
            findingId: params.findingId,
            topicId: finding.topicId,
            checkKind: finding.checkKind,
          },
        });

        return {
          type: "updated",
          finding,
          applicationStatus: recordsApplication
            ? DOCUMENT_REVIEW_APPLICATION_STATUS.APPLIED
            : finding.applicationStatus,
          appliedBy: recordsApplication ? appliedBy : finding.appliedBy,
          appliedAt: recordsApplication ? appliedAt : finding.appliedAt,
          decidedBy,
          decidedAt,
        } as const;
      }),
    );

    if (decided.type === "not-found") {
      return Result.err(
        new HandlerError({ status: 404, message: "Review finding not found" }),
      );
    }
    if (decided.type === "no-fix") {
      return Result.err(
        new HandlerError({
          status: 422,
          message: "This review finding has no proposed edit to apply.",
        }),
      );
    }

    return Result.ok({
      id: params.findingId,
      runId: decided.finding.runId,
      decision,
      decidedBy:
        decided.type === "unchanged"
          ? decided.finding.decidedBy
          : decided.decidedBy,
      decidedAt:
        (decided.type === "unchanged"
          ? decided.finding.decidedAt
          : decided.decidedAt
        )?.toISOString() ?? null,
      applicationStatus:
        decided.type === "unchanged"
          ? decided.finding.applicationStatus
          : decided.applicationStatus,
      appliedBy:
        decided.type === "unchanged"
          ? decided.finding.appliedBy
          : decided.appliedBy,
      appliedAt:
        (decided.type === "unchanged"
          ? decided.finding.appliedAt
          : decided.appliedAt
        )?.toISOString() ?? null,
    });
  },
);

export default decideDocumentReviewFinding;
