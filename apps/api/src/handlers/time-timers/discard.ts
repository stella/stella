import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { timeEntries, timeTimers } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import {
  deleteLegacyTimerDraft,
  lockTimerOwner,
  ownedTimers,
  readOwnedTimer,
  timerNotFound,
  timerParams,
} from "@/api/lib/billing/time-timers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const discardTimer = createSafeRootHandler(
  {
    description:
      "Discard your timer and its unconfirmed time. This creates no time entry.",
    permissions: { timeEntry: ["delete"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    params: timerParams,
  },
  async function* ({ safeDb, session, user, params, recordAuditEvent }) {
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
        const legacy = timer.legacyTimeEntryId
          ? (
              await tx
                .select()
                .from(timeEntries)
                .where(
                  and(
                    eq(timeEntries.id, timer.legacyTimeEntryId),
                    eq(timeEntries.organizationId, owner.organizationId),
                    eq(timeEntries.userId, owner.userId),
                  ),
                )
                .limit(1)
                .for("update")
            ).at(0)
          : undefined;
        if (timer.legacyTimeEntryId && !legacy) {
          return Result.err(
            new HandlerError({
              status: 404,
              message: "Original timer entry is not accessible",
              hint: "Restore access to the original matter before discarding this migrated timer.",
            }),
          );
        }
        await tx
          .delete(timeTimers)
          .where(and(ownedTimers(owner), eq(timeTimers.id, timer.id)));
        if (legacy) {
          await deleteLegacyTimerDraft({
            tx,
            owner,
            entry: legacy,
            timerId: timer.id,
            recordAuditEvent,
          });
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_TIMER,
          resourceId: timer.id,
          workspaceId: timer.workspaceId,
          changes: { discarded: { old: timer.state, new: null } },
        });
        return Result.ok({ id: timer.id });
      }),
    );
    return outcome;
  },
);
export default discardTimer;
