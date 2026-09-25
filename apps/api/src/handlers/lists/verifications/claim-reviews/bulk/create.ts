/**
 * Accept routine claims in one action: every named claim that needs no human
 * judgment and has no status yet is marked reviewed, each with its own event
 * so the record still says, per claim, who accepted it and that it was bulk.
 */

import { Result, panic } from "better-result";
import { and, asc, eq, inArray } from "drizzle-orm";
import { t } from "elysia";

import {
  legalListClaimReviewEvents,
  legalListClaims,
  legalListVerificationRuns,
} from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { VERIFICATION_LIMITS } from "@/api/lib/lists/verification/contract";
import type { ClaimReviewEventPayload } from "@/api/lib/lists/verification/contract";
import {
  readClaimReviews,
  serializeClaimReview,
} from "@/api/lib/lists/verification/read-run";
import {
  EMPTY_CLAIM_REVIEW,
  contestedFactIds,
  needsAttention,
  reviewedView,
} from "@/api/lib/lists/verification/review-fold";

const bodySchema = t.Object({
  runId: tSafeId("legalListVerificationRun"),
  claimIds: t.Array(tSafeId("legalListClaim"), {
    minItems: 1,
    maxItems: VERIFICATION_LIMITS.BULK_CLAIMS_MAX,
    uniqueItems: true,
  }),
});

const config = {
  description:
    "Mark the routine claims among `claimIds` reviewed in one action. A claim " +
    "is routine when its verdict is not a conflict and no fact it rests on " +
    "has a contested meaning; those need an individual decision and are " +
    "refused. Claims that already have a status are left as they are. Returns " +
    "the review of every claim that was marked.",
  permissions: { entity: ["update"] },
  mcp: { type: "capability", reason: "document_processing" },
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

const BULK_REVIEWED = {
  kind: "status",
  status: "reviewed",
  origin: "bulk",
} as const satisfies ClaimReviewEventPayload;

const createBulkClaimReviews = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, user, body, recordAuditEvent }) {
    const { runId, claimIds } = body;

    const result = yield* Result.await(
      safeDb(async (tx) => {
        const run = (
          await tx
            .select({ evidence: legalListVerificationRuns.evidence })
            .from(legalListVerificationRuns)
            .where(
              and(
                eq(legalListVerificationRuns.id, runId),
                eq(legalListVerificationRuns.workspaceId, workspaceId),
              ),
            )
            .limit(1)
        ).at(0);
        if (run === undefined) {
          return { type: "not-found" } as const;
        }
        // Id order is the lock order every caller shares, so two overlapping
        // bulk accepts cannot deadlock.
        const claims = await tx
          .select({
            id: legalListClaims.id,
            state: legalListClaims.state,
            refs: legalListClaims.refs,
            recordConflict: legalListClaims.recordConflict,
          })
          .from(legalListClaims)
          .where(
            and(
              eq(legalListClaims.workspaceId, workspaceId),
              eq(legalListClaims.runId, runId),
              inArray(legalListClaims.id, claimIds),
            ),
          )
          .orderBy(asc(legalListClaims.id))
          .limit(claimIds.length)
          .for("update");
        if (claims.length !== claimIds.length) {
          return { type: "not-found" } as const;
        }

        const before = await readClaimReviews({
          tx,
          workspaceId,
          runId,
          claimIds,
        });
        // Claims already decided are left as they are, so only the rest are
        // held to the routine rule: a conflict someone settled by hand must
        // not block accepting the routine claims around it.
        const toMark = claims.filter((claim) => {
          const record = before.get(claim.id);
          return (
            (record?.review.status ?? null) === null &&
            (record?.eventCount ?? 0) <
              VERIFICATION_LIMITS.REVIEW_EVENTS_PER_CLAIM_MAX
          );
        });
        const contested = contestedFactIds(run.evidence);
        const attention = toMark.filter((claim) =>
          needsAttention(
            reviewedView(
              claim,
              before.get(claim.id)?.review ?? EMPTY_CLAIM_REVIEW,
            ),
            contested,
          ),
        );
        if (attention.length > 0) {
          return {
            type: "needs-attention",
            claimIds: attention.map((claim) => claim.id),
          } as const;
        }
        if (toMark.length === 0) {
          return { type: "marked", reviews: [] } as const;
        }
        await tx.insert(legalListClaimReviewEvents).values(
          toMark.map((claim) => ({
            id: createSafeId<"legalListClaimReviewEvent">(),
            workspaceId,
            runId,
            claimId: claim.id,
            kind: BULK_REVIEWED.kind,
            payload: BULK_REVIEWED,
            actorId: user.id,
          })),
        );
        const markedIds = toMark.map((claim) => claim.id);
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.REVIEW,
          resourceType: AUDIT_RESOURCE_TYPE.LEGAL_LIST_VERIFICATION,
          resourceId: runId,
          metadata: { event: BULK_REVIEWED, claimIds: markedIds },
        });

        const after = await readClaimReviews({
          tx,
          workspaceId,
          runId,
          claimIds: markedIds,
        });
        return {
          type: "marked",
          reviews: markedIds.map((claimId) => ({
            claimId,
            review: serializeClaimReview(
              after.get(claimId)?.review ??
                panic("A marked claim has no review"),
            ),
          })),
        } as const;
      }),
    );

    switch (result.type) {
      case "not-found": {
        return Result.err(
          new HandlerError({
            status: 404,
            message: "Verification or one of its claims not found",
          }),
        );
      }
      case "needs-attention": {
        return Result.err(
          new HandlerError({
            status: 409,
            message: `These claims need an individual decision: ${result.claimIds.join(", ")}`,
          }),
        );
      }
      case "marked": {
        return Result.ok({ reviews: result.reviews });
      }
      default: {
        result satisfies never;
        return panic(`Unhandled outcome: ${String(result)}`);
      }
    }
  },
);

export default createBulkClaimReviews;
