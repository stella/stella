import { rootDb } from "@/api/db/root";
import { envFileDerivativeWorker } from "@/api/env-file-derivative-worker";
import { detached } from "@/api/lib/analytics/capture";
import { createBullMqWorkerHost } from "@/api/lib/bullmq-queue";
import { assertDatabaseLoginPosture } from "@/api/lib/db/assert-database-login-posture";
import { initFileDerivativeWorker } from "@/api/lib/file-derivative-queue";
import { logger } from "@/api/lib/observability/logger";
import { refreshS3 } from "@/api/lib/s3";

await assertDatabaseLoginPosture(rootDb);
await refreshS3();
const workers = createBullMqWorkerHost(
  "file-derivative-worker",
  { db: rootDb },
  envFileDerivativeWorker.SCHEDULED_JOBS_MODE,
  [initFileDerivativeWorker],
);

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info("file_derivative.shutdown_started", { signal });
  await workers.close();
  process.exit(0);
};

process.once("SIGTERM", () => {
  detached(shutdown("SIGTERM"), "file-derivative.shutdown-sigterm");
});
process.once("SIGINT", () => {
  detached(shutdown("SIGINT"), "file-derivative.shutdown-sigint");
});
