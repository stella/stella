import type * as v from "valibot";

import type { envApiServerSchema } from "@/api/env-schema";
import type { logger } from "@/api/lib/observability/logger";
import type { ensureDefaultSchedulerJobs } from "@/api/lib/scheduler/jobs";
import type { startSchedulerLoop } from "@/api/lib/scheduler/runner";

type StartConfiguredSchedulerOptions = {
  mode: v.InferOutput<typeof envApiServerSchema.SCHEDULED_JOBS_MODE>;
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
