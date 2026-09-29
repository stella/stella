import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { isOrganizationManagementRole } from "@stll/permissions";

import { timeTimerConfirmations, timeTimers } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

import { finalizeTimer } from "../finalize";
import { timerNotFound, timerParams } from "@/api/lib/billing/time-timers";

const stopMemberTimer = createSafeRootHandler(
  {
    description:
      "End a member's running timer in the active organization into that member's draft entry. Only organization owners and admins can end timers. Uses the timer description first; supply narrative when it is empty and policy requires one. Refuses inaccessible matters and locked months without changing the timer. Retry the same ID to retrieve the original entry. timezoneId is an IANA timezone for the work date.",
    permissions: { timeEntry: ["approve"] },
    mcp: { type: "capability", reason: "billing_admin" },
    params: timerParams,
    body: t.Object({
      timezoneId: t.String({ minLength: 1, maxLength: 64 }),
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
    if (!isOrganizationManagementRole(memberRole.role)) {
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
          body: { timezoneId: body.timezoneId },
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
    return outcome;
  },
);
export default stopMemberTimer;
