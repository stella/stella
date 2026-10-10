import { Result } from "better-result";
import { and, eq, getColumns, ne, or } from "drizzle-orm";
import { t } from "elysia";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import { BILLING_STATUS, timeEntries, workspaces } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { lockTimePolicy } from "@/api/lib/billing-time";
import { recordBillingCapCrossings } from "@/api/lib/billing/arrangements";
import { timeApprovalRefusal } from "@/api/lib/billing/time-entry-approval";
import {
  guardRunningTimeEntries,
  timeEntryIsRunning,
} from "@/api/lib/billing/time-entry-running";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const returnTimeEntry = createSafeRootHandler(
  {
    description:
      "Return one draft or approved time entry to draft with a required comment (up to 2000 characters). Only its assigned approver or an organization owner/admin may return it. Running timers and locked periods are refused. The owner keeps seeing the last comment while editing; re-approval clears it. Billed or written-off entries cannot be returned.",
    permissions: { timeEntry: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    access: "write",
    body: t.Object({
      id: tSafeId("timeEntry"),
      comment: t.String({
        minLength: 1,
        maxLength: LIMITS.timeEntryReturnCommentMaxLength,
        pattern: "\\S",
      }),
    }),
  },
  async function* ({
    safeDb,
    session,
    user,
    memberRole,
    body,
    recordAuditEvent,
  }) {
    const comment = body.comment.trim();
    if (!comment || comment.length > LIMITS.timeEntryReturnCommentMaxLength) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "return_comment_required",
          message:
            "A nonblank return comment of at most 2000 characters is required",
          hint: "Explain what the owner should correct, then retry.",
        }),
      );
    }
    const now = new Date();
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const policy = await lockTimePolicy(tx, session.activeOrganizationId);
        const runningError = await guardRunningTimeEntries({
          tx,
          organizationId: session.activeOrganizationId,
          actorUserId: user.id,
          selection: { type: "approval_batch", ids: [body.id] },
        });
        if (runningError) {
          return Result.err(runningError);
        }
        const [entry] = await tx
          .select({
            ...getColumns(timeEntries),
            running: timeEntryIsRunning(),
          })
          .from(timeEntries)
          .leftJoin(
            workspaces,
            and(
              eq(timeEntries.workspaceId, workspaces.id),
              eq(workspaces.organizationId, session.activeOrganizationId),
            ),
          )
          .where(
            and(
              eq(timeEntries.id, body.id),
              eq(timeEntries.organizationId, session.activeOrganizationId),
              or(
                eq(
                  timeEntries.activityGroup,
                  TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
                ),
                and(
                  eq(
                    timeEntries.activityGroup,
                    TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
                  ),
                  ne(workspaces.status, "deleting"),
                ),
              ),
            ),
          )
          .limit(1)
          .for("update", { of: timeEntries });
        if (!entry) {
          return Result.err(
            new HandlerError({
              status: 404,
              code: "not_found",
              message: "Time entry not found",
              hint: "List the approval queue and use an accessible entry id.",
            }),
          );
        }
        const reason = timeApprovalRefusal({
          entry,
          memberRole,
          currentUserId: user.id,
          policy,
          now,
          action: "return",
        });
        if (reason) {
          return Result.err(
            new HandlerError({
              status: 409,
              code: reason,
              message: "Time entry cannot be returned",
              hint: "Check the assigned approver, entry status, running timer, and locked period.",
            }),
          );
        }
        if (
          entry.status === BILLING_STATUS.DRAFT &&
          entry.returnComment === comment &&
          entry.returnedByUserId === user.id
        ) {
          if (entry.workspaceId !== null) {
            await recordBillingCapCrossings(tx, {
              workspaceId: entry.workspaceId,
              recordAuditEvent,
            });
          }
          return Result.ok({ id: entry.id, status: BILLING_STATUS.DRAFT });
        }
        await tx
          .update(timeEntries)
          .set({
            status: BILLING_STATUS.DRAFT,
            approvedByUserId: null,
            approvedAt: null,
            returnedAt: now,
            returnedByUserId: user.id,
            returnComment: comment,
            updatedAt: now,
          })
          .where(
            and(
              eq(timeEntries.id, entry.id),
              eq(timeEntries.organizationId, session.activeOrganizationId),
            ),
          );
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_ENTRY,
          resourceId: entry.id,
          workspaceId: entry.workspaceId,
          changes: {
            status: { old: entry.status, new: BILLING_STATUS.DRAFT },
            returnComment: { old: entry.returnComment, new: comment },
            returnedByUserId: { old: entry.returnedByUserId, new: user.id },
            returnedAt: { old: entry.returnedAt, new: now },
            approvedAt: { old: entry.approvedAt, new: null },
            approvedByUserId: { old: entry.approvedByUserId, new: null },
          },
        });
        if (entry.workspaceId !== null) {
          await recordBillingCapCrossings(tx, {
            workspaceId: entry.workspaceId,
            recordAuditEvent,
          });
        }
        return Result.ok({ id: entry.id, status: BILLING_STATUS.DRAFT });
      }),
    );
    return outcome;
  },
);
export default returnTimeEntry;
