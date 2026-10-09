import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { timeTimerConfirmations, timeTimers } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { timerNotFound, timerParams } from "@/api/lib/billing/time-timers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasManagementPermission } from "@/api/lib/permission-authorization";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

import { finalizeTimer } from "../finalize";

const stopMemberTimer = createSafeRootHandler(
  {
    description:
      "End a member's running timer in the active organization into that member's draft entry. Only organization owners and admins can end timers. Uses the timer description first; supply narrative when it is empty and policy requires one. Refuses inaccessible matters and locked months without changing the timer. Retry the same ID to retrieve the original entry. The work date uses the timer owner's timezone.",
    permissions: { timeEntry: ["approve"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    access: "write",
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    params: timerParams,
    body: t.Object({
      narrative: t.Optional(t.String({ maxLength: 10_000 })),
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
    if (!hasManagementPermission(memberRole, { timeEntry: ["approve"] })) {
      return Result.err(
        new HandlerError({
          status: 403,
          code: "timer_admin_required",
          message:
            "Only organization owners and admins can end another member's timer",
          hint: "Ask an organization admin to end the timer.",
        }),
      );
    }
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const organizationId = session.activeOrganizationId;
        const [timer] = await tx
          .select({ userId: timeTimers.userId })
          .from(timeTimers)
          .where(
            and(
              eq(timeTimers.organizationId, organizationId),
              eq(timeTimers.id, params.id),
            ),
          )
          .limit(1);
        const [receipt] = timer
          ? []
          : await tx
              .select({ userId: timeTimerConfirmations.userId })
              .from(timeTimerConfirmations)
              .where(
                and(
                  eq(timeTimerConfirmations.organizationId, organizationId),
                  eq(timeTimerConfirmations.timerId, params.id),
                ),
              )
              .limit(1);
        const ownerId = timer?.userId ?? receipt?.userId;
        if (!ownerId) {
          return Result.err(timerNotFound("admin"));
        }
        return finalizeTimer({
          tx,
          owner: { organizationId, userId: brandPersistedUserId(ownerId) },
          id: params.id,
          memberRole,
          recordAuditEvent,
          completion: {
            type: "admin",
            actorId: user.id,
            narrative: body.narrative,
          },
        });
      }),
    );
    return Result.ok(yield* outcome);
  },
);
export default stopMemberTimer;
