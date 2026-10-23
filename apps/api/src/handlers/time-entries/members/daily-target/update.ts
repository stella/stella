import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import {
  dailyTargetBody,
  setDailyTarget,
} from "@/api/lib/billing/daily-target";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasManagementPermission } from "@/api/lib/permission-authorization";

const updateMemberDailyTarget = createSafeRootHandler(
  {
    contract: "patch",
    description:
      "Set a current member's daily time target in the active organization. Only organization owners and admins may set another member's target. Pass minutes from 1 to 1440, or null to clear it.",
    permissions: { organizationSettings: ["update"] },
    accountAccess: ACCOUNT_ACCESS.standard,
    featureAccess: { featureId: "time-billing", type: "required" },
    access: "write",
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    params: v.object({ userId: resourceIdSchema("user") }),
    body: dailyTargetBody,
  },
  async function* ({
    safeDb,
    session,
    memberRole,
    params,
    body,
    recordAuditEvent,
  }) {
    if (
      !hasManagementPermission(memberRole, {
        organizationSettings: ["update"],
      })
    ) {
      return Result.err(
        new HandlerError({
          status: 403,
          code: "daily_target_admin_required",
          message: "Only organization owners and admins can set member targets",
          hint: "Set your own target with time-entries.me.daily-target.update, or ask an organization admin.",
        }),
      );
    }
    return yield* setDailyTarget({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: params.userId,
      minutes: body.minutes,
      recordAuditEvent,
    });
  },
);
export default updateMemberDailyTarget;
