import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";

import { finalizeTimer } from "./finalize";
import { timerParams } from "@/api/lib/billing/time-timers";

const confirmTimer = createSafeRootHandler(
  {
    description:
      "Confirm your timer into a draft time entry and remove it. Assign a matter with update first. Rounds billed minutes to the organization's minimum unit and enforces narrative and monthly locks. Retry with the same timer ID to get the original entry ID without creating another entry. timezoneId is an IANA timezone for the work date; timers without an effective rate default to non-billable.",
    permissions: { timeEntry: ["create"] },
    mcp: { type: "capability", reason: "billing_admin" },
    params: timerParams,
    body: t.Object({
      timezoneId: t.String({ minLength: 1, maxLength: 64 }),
      billable: t.Optional(t.Boolean()),
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
          },
        }),
      ),
    );
    return Result.ok(yield* outcome);
  },
);
export default confirmTimer;
