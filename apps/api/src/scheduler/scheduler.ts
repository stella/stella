import { logger } from "@/api/lib/observability/logger";
import { ensureDefaultSchedulerJobs } from "@/api/lib/scheduler/jobs";
import { startSchedulerLoop } from "@/api/lib/scheduler/runner";

await ensureDefaultSchedulerJobs();

const loop = startSchedulerLoop();

logger.info("scheduler.started", {
  "scheduler.runner_id": loop.runnerId,
});

await new Promise<void>((resolve) => {
  const shutdown = () => {
    loop.stop();
    void loop.drained.then(() => {
      logger.info("scheduler.stopped", {
        "scheduler.runner_id": loop.runnerId,
      });
      resolve();
      return;
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
});
