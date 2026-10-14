import { createBullMqWorkerHost } from "@/api/lib/bullmq-queue";
import { assertDatabaseLoginPosture } from "@/api/lib/db/assert-database-login-posture";

declare const db: Parameters<typeof createBullMqWorkerHost>[1]["db"];
declare const starters: Parameters<typeof createBullMqWorkerHost>[3];

export const uncheckedHost = () =>
  // oxlint-disable-next-line require-worker-database-login-posture/require-worker-database-login-posture -- fixture: the worker host requires a completed login posture check
  createBullMqWorkerHost("api", { db }, "disabled", starters);

export const checkedHost = async () => {
  await assertDatabaseLoginPosture(db);
  // expect-clean: require-worker-database-login-posture/require-worker-database-login-posture
  return createBullMqWorkerHost("api", { db }, "disabled", starters);
};
