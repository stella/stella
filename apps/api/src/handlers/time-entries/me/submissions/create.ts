import { Result } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE } from "@stll/api-contract";
import { API_CALENDAR_DATE_CHECK } from "@stll/api-contract/api-date";
import { parsePlainDate } from "@stll/time";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { submitTimeEntries } from "@/api/lib/billing/time-entry-submission";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { organizationResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const workDateSchema = (description: string) =>
  v.pipe(
    v.string(),
    v.isoDate(),
    API_CALENDAR_DATE_CHECK,
    v.description(description),
  );

const config = {
  contract: "patch",
  description:
    "Submit the signed-in user's draft time entries for startDate through endDate (one to seven work dates, YYYY-MM-DD) to their approvers. Each draft is submitted or refused with its reason (running_timer, unpriced, narrative_required, time_period_locked, invalid_entry; wrong_status or not_found when it changed during the call), and the rest still move. The conditions are checked again by the write itself, so a draft edited meanwhile is refused rather than submitted. A submitted entry is read-only to its timekeeper until an approver approves it or returns it to draft. Pass approve: true to approve in the same step every draft the user is the approver of (a solo practitioner); the others are submitted.",
  permissions: { timeEntry: ["update"] },
  realtime: organizationResourceSetUpdates(RESOURCE_TYPE.TIME_ENTRY),
  accountAccess: ACCOUNT_ACCESS.sandbox,
  featureAccess: { featureId: "time-billing", type: "required" },
  mcp: {
    type: "capability",
    reason: "billing_admin",
    consumesServices: false,
  },
  access: "write",
  body: v.object({
    startDate: workDateSchema("First work date in YYYY-MM-DD format"),
    endDate: workDateSchema(
      "Last work date in YYYY-MM-DD format, at most six days after startDate",
    ),
    approve: v.optional(
      v.pipe(
        v.boolean(),
        v.description(
          "Approve the drafts the user is the approver of instead of submitting them",
        ),
      ),
    ),
  }),
} satisfies HandlerConfig;

const submitMyTimeEntries = createSafeRootHandler(
  config,
  async function* ({
    body,
    safeDb,
    session,
    user,
    memberRole,
    recordAuditEvent,
  }) {
    const start = parsePlainDate(body.startDate);
    const end = parsePlainDate(body.endDate);
    const days =
      start === null || end === null
        ? null
        : start.until(end, { largestUnit: "days" }).days + 1;
    if (days === null || days < 1 || days > LIMITS.timeRangeDaysMax) {
      return Result.err(
        new HandlerError({
          status: 400,
          code: "invalid_date_range",
          message: `Submit 1 to ${LIMITS.timeRangeDaysMax} work dates at a time`,
          hint: "Pass an endDate on or after startDate and at most six days later.",
        }),
      );
    }
    const outcome = yield* Result.await(
      submitTimeEntries({
        safeDb,
        organizationId: session.activeOrganizationId,
        userId: user.id,
        memberRole,
        startDate: body.startDate,
        endDate: body.endDate,
        approve: body.approve ?? false,
        recordAuditEvent,
      }),
    );
    return outcome;
  },
);

declareAggregateMutation(submitMyTimeEntries, {
  type: "independent",
  reason:
    "Moves only the caller's own draft entries for the dates, each with a status-guarded update. Approving in the same step takes the approval queue's timer owner, matter and entry locks before any row moves, then reconciles those matters' billing caps.",
});

export default submitMyTimeEntries;
