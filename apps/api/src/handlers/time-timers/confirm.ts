import { Result } from "better-result";
import * as v from "valibot";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { timerParams } from "@/api/lib/billing/time-timers";

import { finalizeTimer } from "./finalize";

const confirmTimer = createSafeRootHandler(
  {
    contract: "patch",
    description:
      "Confirm your timer into a draft time entry and remove it. For client work, assign a matter with update first. Request activityGroup internal only for a timer without a matter; internal entries have zero billed minutes and cannot be billable. Rounds client billed minutes to the organization's minimum unit and enforces narrative and monthly locks. Retry with the same timer ID to get the original entry ID without creating another entry. timezoneId is an IANA timezone for the work date; timers without an effective rate default to non-billable.",
    permissions: { timeEntry: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    params: timerParams,
    body: v.object({
      timezoneId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
      billable: v.optional(v.boolean()),
      activityGroup: v.optional(
        v.union([
          v.literal(TIME_ENTRY_ACTIVITY_GROUP.CLIENT),
          v.literal(TIME_ENTRY_ACTIVITY_GROUP.INTERNAL),
        ]),
      ),
    }),
  },
  async function* ({
    safeDb,
    session,
    user,
    memberRole,
    params,
    body,
    recordAuditEvent,
  }) {
    const owner = {
      organizationId: session.activeOrganizationId,
      userId: user.id,
    };
    const outcome = yield* Result.await(
      safeDb(async (tx) =>
        finalizeTimer({
          tx,
          owner,
          id: params.id,
          memberRole,
          recordAuditEvent,
          completion: {
            type: "owner",
            timezoneId: body.timezoneId,
            billable: body.billable,
            activityGroup: body.activityGroup,
          },
        }),
      ),
    );
    return Result.ok(yield* outcome);
  },
);
export default confirmTimer;
