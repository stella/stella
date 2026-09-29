import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { timeTimers } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";

import {
  lockTimerOwner,
  ownedTimers,
  pauseRunningTimers,
  readOwnedTimer,
  timerItem,
  timerNotFound,
  timerParams,
} from "./shared";

const resumeTimer = createSafeRootHandler(
  {
    description:
      "Resume your paused timer and automatically pause your other running timer. Resuming an already running timer leaves its elapsed time unchanged.",
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
        if (timer.state === "running") {
          return Result.ok(timerItem(timer));
        }
        const now = new Date();
        await pauseRunningTimers({ tx, owner, now, recordAuditEvent });
        const [resumed] = await tx
          .update(timeTimers)
          .set({ state: "running", lastResumedAt: now, updatedAt: now })
          .where(and(ownedTimers(owner), eq(timeTimers.id, timer.id)))
          .returning();
        if (!resumed) {
          return panic("Locked timer update returned no row");
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.TIME_TIMER,
          resourceId: timer.id,
          workspaceId: timer.workspaceId,
          changes: { state: { old: timer.state, new: "running" } },
        });
        return Result.ok(timerItem(resumed));
      }),
    );
    return outcome;
  },
);
export default resumeTimer;
