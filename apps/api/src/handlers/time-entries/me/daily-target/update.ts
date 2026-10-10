import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import {
  dailyTargetBody,
  setDailyTarget,
} from "@/api/lib/billing/daily-target";

const updateDailyTarget = createSafeRootHandler(
  {
    description:
      "Set the signed-in user's daily time target in the active organization. Pass minutes from 1 to 1440, or null to clear the target. Read time-entries.me.list for the target and remaining minutes for a work date.",
    permissions: { timeEntry: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    access: "write",
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    body: dailyTargetBody,
  },
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    return yield* setDailyTarget({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      minutes: body.minutes,
      recordAuditEvent,
    });
  },
);
export default updateDailyTarget;
