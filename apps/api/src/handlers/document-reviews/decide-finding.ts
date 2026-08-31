/**
 * Record what a reviewer says about one finding: the disposition they took,
 * and the flags they put beside it.
 *
 * The decision is the reviewer's, so it is written with their identity and the
 * moment they took it; reopening a finding withdraws both, leaving no decider
 * attached to an undecided row. The database enforces that pairing, so this
 * handler cannot leave the two halves inconsistent.
 *
 * Flags are the other axis and move independently: a body that omits them
 * changes none, and restating the decision the row already holds re-stamps
 * nothing — which is what lets a flag toggle carry the current decision along
 * without rewriting when it was taken.
 */

import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { documentReviewFindings } from "@/api/db/schema";
import { decideReviewFindingBodySchema } from "@/api/handlers/document-reviews/schemas";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { FieldDiffs } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import {
  DOCUMENT_REVIEW_APPLICATION_STATUS,
  DOCUMENT_REVIEW_DECISION,
} from "@/api/lib/document-review/run-contract";
import type { DocumentReviewFindingFlag } from "@/api/lib/document-review/run-contract";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Record a reviewer's decision on one review finding, the flags they put beside it, and, when requested, the durable application of its proposed edit.",
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

/** Flags are a set: stored deduplicated and in one order, so two spellings of
 *  the same triage compare equal and read back the same. */
const normalizeFindingFlags = (
  flags: readonly DocumentReviewFindingFlag[],
): DocumentReviewFindingFlag[] => [...new Set(flags)].toSorted();

const haveSameFlags = (
  a: readonly DocumentReviewFindingFlag[],
  b: readonly DocumentReviewFindingFlag[],
): boolean =>
  a.length === b.length && a.every((flag, index) => flag === b[index]);

type TakeDecisionArgs = {
  decisionChanged: boolean;
  existing: { decidedBy: string | null; decidedAt: Date | null };
  now: Date;
  reopening: boolean;
  userId: string;
};

type TakenDecision = { decidedBy: string | null; decidedAt: Date | null };

/** Who a decision belongs to and when it was taken, after this write. The two
 *  always move together: the column pair's CHECK refuses any other pairing. */
const takeDecision = ({
  decisionChanged,
  existing,
  now,
  reopening,
  userId,
}: TakeDecisionArgs): TakenDecision => {
  if (!decisionChanged) {
    return { decidedBy: existing.decidedBy, decidedAt: existing.decidedAt };
  }
  if (reopening) {
    return { decidedBy: null, decidedAt: null };
  }
  return { decidedBy: userId, decidedAt: now };
};

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
    // `null` means "the request said nothing about flags", which is different
    // from `[]`, which means "clear them".
    const requestedFlags =
      body.flags === undefined ? null : normalizeFindingFlags(body.flags);

    const decided = yield* Result.await(
      safeDb(async (tx) => {
        // Read first for the audit diff, and for the 404: a finding in another
        // workspace is indistinguishable from one that does not exist.
        const rows = await tx
          .select({
            runId: documentReviewFindings.runId,
            positionId: documentReviewFindings.positionId,
            payload: documentReviewFindings.payload,
            decision: documentReviewFindings.decision,
            decidedBy: documentReviewFindings.decidedBy,
            decidedAt: documentReviewFindings.decidedAt,
            flags: documentReviewFindings.flags,
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

        const alreadyApplied =
          finding.applicationStatus ===
          DOCUMENT_REVIEW_APPLICATION_STATUS.APPLIED;
        const decisionChanged = finding.decision !== decision;
        const flagsChanged =
          requestedFlags !== null &&
          !haveSameFlags(finding.flags, requestedFlags);
        if (
          recordsApplication &&
          alreadyApplied &&
          !decisionChanged &&
          !flagsChanged
        ) {
          return { type: "unchanged", finding } as const;
        }

        // A decision restated is not a decision retaken: the moment and the
        // decider stay as the row recorded them. Taking one stamps both;
        // reopening withdraws both, which the column pair's CHECK requires.
        const { decidedAt, decidedBy } = takeDecision({
          decisionChanged,
          existing: finding,
          now,
          reopening,
          userId: user.id,
        });
        const flags = requestedFlags ?? finding.flags;
        const appliedAt = alreadyApplied ? finding.appliedAt : now;
        const appliedBy = alreadyApplied ? finding.appliedBy : user.id;

        await tx
          .update(documentReviewFindings)
          .set({
            decision,
            decidedBy,
            decidedAt,
            ...(requestedFlags !== null && { flags: requestedFlags }),
            ...(recordsApplication && {
              applicationStatus: DOCUMENT_REVIEW_APPLICATION_STATUS.APPLIED,
              appliedBy,
              appliedAt,
            }),
          })
          .where(
            and(
              eq(documentReviewFindings.id, params.findingId),
              eq(documentReviewFindings.workspaceId, workspaceId),
            ),
          );

        const changes: FieldDiffs = {};
        if (decisionChanged) {
          changes["decision"] = { old: finding.decision, new: decision };
        }
        if (recordsApplication && !alreadyApplied) {
          changes["applicationStatus"] = {
            old: finding.applicationStatus,
            new: DOCUMENT_REVIEW_APPLICATION_STATUS.APPLIED,
          };
        }
        if (flagsChanged) {
          changes["flags"] = { old: finding.flags, new: flags };
        }

        // A request that restated what the row already said wrote nothing new;
        // auditing it would record a reviewer action nobody took.
        if (Object.keys(changes).length > 0) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.REVIEW,
            // A finding is addressed through the run that produced it, so the
            // decision is audited against that run rather than introducing a
            // second resource noun for a subresource.
            resourceType: AUDIT_RESOURCE_TYPE.DOCUMENT_REVIEW_RUN,
            resourceId: finding.runId,
            changes,
            metadata: {
              findingId: params.findingId,
              positionId: finding.positionId,
            },
          });
        }

        return {
          type: "updated",
          finding,
          flags,
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
      flags:
        decided.type === "unchanged" ? decided.finding.flags : decided.flags,
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
