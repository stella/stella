import { panic, Result } from "better-result";

import { timeTimers } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  lockTimerOwner,
  pauseRunningTimers,
  timerDetails,
  timerItem,
} from "@/api/lib/billing/time-timers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasCurrentTimerMatterAccess } from "@/api/lib/time-entry-timer-access";

const startTimer = createSafeRootHandler(
  {
    description:
      "Start your timer in the active organization, optionally assigning a matter and description. Automatically pauses your running timer. Returns its ID for pause, resume, update, confirm or discard.",
    permissions: { timeEntry: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    body: timerDetails,
  },
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    const owner = {
      organizationId: session.activeOrganizationId,
      userId: user.id,
    };
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        await lockTimerOwner(tx, owner);
        const now = new Date();
        if (
          body.matterId &&
          !(await hasCurrentTimerMatterAccess({
            tx,
            ...owner,
            workspaceId: body.matterId,
          }))
        ) {
          return Result.err(
            new HandlerError({
              status: 404,
              message: "Matter not found or not accessible",
            }),
          );
        }
        await pauseRunningTimers({ tx, owner, now, recordAuditEvent });
        const [timer] = await tx
          .insert(timeTimers)
          .values({
            ...owner,
            workspaceId: body.matterId ?? null,
            description: body.description ?? null,
            state: "running",
            startedAt: now,
            lastResumedAt: now,
          })
          .returning();
        if (!timer) {
          return panic("Timer insert returned no row");
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_TIMER,
          resourceId: timer.id,
          workspaceId: timer.workspaceId,
          changes: { state: { old: null, new: timer.state } },
        });
        return Result.ok(timerItem(timer));
      }),
    );
    return outcome;
  },
);
export default startTimer;
