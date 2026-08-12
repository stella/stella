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
import { DOCUMENT_REVIEW_DECISION } from "@/api/lib/document-review/run-contract";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Record a reviewer's decision on one review finding: accept it, dismiss it, or reopen it for review.",
  permissions: { workspace: ["read"] },
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
    const { decision } = body;
    const reopening = decision === DOCUMENT_REVIEW_DECISION.OPEN;
    const decidedAt = reopening ? null : new Date();
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
            decision: documentReviewFindings.decision,
          })
          .from(documentReviewFindings)
          .where(
            and(
              eq(documentReviewFindings.id, params.findingId),
              eq(documentReviewFindings.workspaceId, workspaceId),
            ),
          )
          .limit(1);
        const finding = rows.at(0);
        if (finding === undefined) {
          return null;
        }

        await tx
          .update(documentReviewFindings)
          .set({ decision, decidedBy, decidedAt })
          .where(
            and(
              eq(documentReviewFindings.id, params.findingId),
              eq(documentReviewFindings.workspaceId, workspaceId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.REVIEW,
          // A finding is addressed through the run that produced it, so the
          // decision is audited against that run rather than introducing a
          // second resource noun for a subresource.
          resourceType: AUDIT_RESOURCE_TYPE.DOCUMENT_REVIEW_RUN,
          resourceId: finding.runId,
          changes: { decision: { old: finding.decision, new: decision } },
          metadata: {
            findingId: params.findingId,
            topicId: finding.topicId,
            checkKind: finding.checkKind,
          },
        });

        return finding;
      }),
    );

    if (decided === null) {
      return Result.err(
        new HandlerError({ status: 404, message: "Review finding not found" }),
      );
    }

    return Result.ok({
      id: params.findingId,
      runId: decided.runId,
      decision,
      decidedBy,
      decidedAt: decidedAt === null ? null : decidedAt.toISOString(),
    });
  },
);

export default decideDocumentReviewFinding;
