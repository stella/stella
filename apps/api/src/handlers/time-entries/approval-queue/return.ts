import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { returnTimeEntryBatch } from "@/api/lib/billing/time-entry-approval";
import { resourceIdSchema, uniqueItems } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";

const returnTimeEntries = createSafeRootHandler(
  {
    contract: "patch",
    description:
      "Return up to 200 submitted or approved time entries to draft with one required comment (up to 2000 characters). Only the assigned approver or an organization owner/admin may return an entry. Each id returns returned or a refusal reason: a draft that was never returned is not_submitted; running timers, locked periods, and billed or written-off entries are refused. Each returned entry is audited. The owner keeps seeing the comment while editing and can submit again; approval clears it. Repeating a return with the same comment is safe.",
    permissions: { timeEntry: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    access: "write",
    body: v.object({
      ids: v.pipe(
        v.array(resourceIdSchema("timeEntry")),
        v.minLength(1),
        v.maxLength(LIMITS.timeEntriesApprovalBatchMax),
        uniqueItems(),
      ),
      comment: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(LIMITS.timeEntryReturnCommentMaxLength),
        v.regex(/\S/u),
      ),
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
    const outcome = yield* Result.await(
      returnTimeEntryBatch({
        safeDb,
        organizationId: session.activeOrganizationId,
        ids: body.ids,
        comment,
        recordAuditEvent,
        memberRole,
        currentUserId: user.id,
      }),
    );
    return outcome;
  },
);
export default returnTimeEntries;
