import type * as v from "valibot";

import type { scheduledJobsModeSchema } from "@/api/env-document-processing-worker-schema";
import type { logger } from "@/api/lib/observability/logger";
import type { ensureDefaultSchedulerJobs } from "@/api/lib/scheduler/jobs";
import type { startSchedulerLoop } from "@/api/lib/scheduler/runner";

type StartConfiguredSchedulerOptions = {
  mode: v.InferOutput<typeof scheduledJobsModeSchema>;
  ensureDefaultJobs: typeof ensureDefaultSchedulerJobs;
  startLoop: () => ReturnType<typeof startSchedulerLoop>;
  logger: Pick<typeof logger, "info">;
};

export const startConfiguredScheduler = async ({
  mode,
  ensureDefaultJobs,
  startLoop,
  logger,
}: StartConfiguredSchedulerOptions) => {
  if (mode === "disabled") {
    return undefined;
  }

  await ensureDefaultJobs();
  const loop = startLoop();
  logger.info("scheduler.started", {
    "scheduler.runner_id": loop.runnerId,
  });
  return loop;
};
