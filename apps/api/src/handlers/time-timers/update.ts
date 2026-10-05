import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { timeTimers } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  lockTimerOwner,
  ownedTimers,
  readOwnedTimer,
  timerDetails,
  timerItem,
  timerNotFound,
  timerParams,
} from "@/api/lib/billing/time-timers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { hasCurrentTimerMatterAccess } from "@/api/lib/time-entry-timer-access";

const updateTimer = createSafeRootHandler(
  {
    description:
      "Set your timer's description or matter. Pass null to clear either field. Confirm requires a matter and any narrative required by the organization.",
    permissions: { timeEntry: ["update"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    params: timerParams,
    body: timerDetails,
  },
  async function* ({ safeDb, session, user, params, body, recordAuditEvent }) {
    const owner = {
      organizationId: session.activeOrganizationId,
      userId: user.id,
    };
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        await lockTimerOwner(tx, owner);
        const timer = await readOwnedTimer({ tx, owner, id: params.id });
        if (!timer) {
          return Result.err(timerNotFound());
        }
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
        const [updated] = await tx
          .update(timeTimers)
          .set({
            workspaceId:
              body.matterId === undefined ? timer.workspaceId : body.matterId,
            description:
              body.description === undefined
                ? timer.description
                : body.description,
            updatedAt: new Date(),
          })
          .where(and(ownedTimers(owner), eq(timeTimers.id, timer.id)))
          .returning();
        if (!updated) {
          return panic("Locked timer update returned no row");
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_TIMER,
          resourceId: timer.id,
          workspaceId: updated.workspaceId,
          changes: {
            matterId: { old: timer.workspaceId, new: updated.workspaceId },
            description: { old: timer.description, new: updated.description },
          },
        });
        return Result.ok(timerItem(updated));
      }),
    );
    return outcome;
  },
);
export default updateTimer;
