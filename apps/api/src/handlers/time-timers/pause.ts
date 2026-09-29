import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { timeTimers } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

import {
  lockTimerOwner,
  ownedTimers,
  readOwnedTimer,
  timerItem,
  timerNotFound,
  timerParams,
  timerSeconds,
} from "./shared";

const pauseTimer = createSafeRootHandler(
  {
    description:
      "Pause your timer without creating a time entry. Pausing an already paused timer leaves its elapsed time unchanged.",
    permissions: { timeEntry: ["update"] },
    mcp: { type: "capability", reason: "billing_admin" },
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
        if (timer.state === "paused") {
          return Result.ok(timerItem(timer));
        }
        const now = new Date();
        const [paused] = await tx
          .update(timeTimers)
          .set({
            state: "paused",
            accumulatedSeconds: timerSeconds(timer, now),
            lastResumedAt: null,
            updatedAt: now,
          })
          .where(and(ownedTimers(owner), eq(timeTimers.id, timer.id)))
          .returning();
        if (!paused) {
          return panic("Locked timer update returned no row");
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_TIMER,
          resourceId: timer.id,
          workspaceId: timer.workspaceId,
          changes: { state: { old: timer.state, new: "paused" } },
        });
        return Result.ok(timerItem(paused));
      }),
    );
    return outcome;
  },
);
export default pauseTimer;
