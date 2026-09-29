import { Result } from "better-result";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { changeTimerState, timerParams } from "@/api/lib/time-timers";

type TimerStateHandlerOptions = {
  description: string;
  state: "running" | "paused";
};
export const createTimerStateHandler = ({
  description,
  state,
}: TimerStateHandlerOptions) =>
  createSafeRootHandler(
    {
      description,
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
        safeDb(async (tx) =>
          changeTimerState({
            tx,
            owner,
            id: params.id,
            state,
            recordAuditEvent,
          }),
        ),
      );
      return Result.ok(yield* outcome);
    },
  );
