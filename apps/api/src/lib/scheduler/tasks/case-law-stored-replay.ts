import { Result } from "better-result";

import { BACKGROUND_REPLAY_LIMITS } from "@/api/handlers/case-law/ingestion/replay-enrolment";
import {
  type SchedulerTask,
  SchedulerTaskFailure,
} from "@/api/lib/scheduler/types";
import type { runEnabledReplayTick } from "@/api/scripts/replay-tick-command";

export const REPLAY_CASE_LAW_STORED_TASK = "caseLaw.replayStored" as const;
export const REPLAY_CASE_LAW_STORED_JOB =
  `${REPLAY_CASE_LAW_STORED_TASK}.minutely` as const;

/** The scheduler owns recurrence; replay owns claims, receipts and admission. */
export const createCaseLawStoredReplayTask =
  (runTick: typeof runEnabledReplayTick): SchedulerTask =>
  async ({ signal, dueAt, scheduleContinuation }) => {
    const attempted = await Result.tryPromise(async () => {
      const report = await runTick(
        AbortSignal.any([
          signal,
          AbortSignal.timeout(BACKGROUND_REPLAY_LIMITS.hardDurationMs),
        ]),
      );
      if (report?.status === "time-limit") {
        scheduleContinuation(dueAt.toDate());
      }
      if (report?.status === "failed") {
        return Result.err(
          new SchedulerTaskFailure({
            message: "Stored case-law replay failed",
            cause: report,
          }),
        );
      }
      return Result.ok(undefined);
    });
    if (attempted.isErr()) {
      return Result.err(
        new SchedulerTaskFailure({
          message: "Stored case-law replay failed",
          cause: attempted.error,
        }),
      );
    }
    return attempted.value;
  };

export const replayCaseLawStoredTask: SchedulerTask = async (context) => {
  const { runEnabledReplayTick } =
    await import("@/api/scripts/replay-tick-command");
  return await createCaseLawStoredReplayTask(runEnabledReplayTick)(context);
};
