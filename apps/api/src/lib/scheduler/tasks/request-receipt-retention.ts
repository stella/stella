import { panic } from "better-result";

import { sweepExpiredRequestReceipts } from "@/api/lib/idempotency/request-receipts";
import type { SchedulerTask } from "@/api/lib/scheduler/types";

export const SWEEP_REQUEST_RECEIPTS_TASK = "requests.sweepReceipts" as const;
const MAX_BATCHES_PER_RUN = 4;
const RUN_BUDGET_MS = 30_000;

type DrainRequestReceiptsOptions = {
  paused: boolean;
  signal: AbortSignal;
  sweep: (deadline: number) => ReturnType<typeof sweepExpiredRequestReceipts>;
  now: () => number;
  scheduleContinuation: () => void;
};

export const drainRequestReceipts = async ({
  paused,
  signal,
  sweep,
  now,
  scheduleContinuation,
}: DrainRequestReceiptsOptions) => {
  const isCancelled = () => signal.aborted;
  if (paused || isCancelled()) {
    return 0;
  }
  const deadline = now() + RUN_BUDGET_MS;
  let deleted = 0;
  let exhausted = true;
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    if (isCancelled() || now() >= deadline) {
      break;
    }
    const swept = await sweep(deadline);
    deleted += swept.deleted;
    if (!swept.hasMore) {
      exhausted = false;
      break;
    }
  }
  if (exhausted && !isCancelled()) {
    scheduleContinuation();
  }
  return deleted;
};

export const sweepRequestReceipts: SchedulerTask = async ({
  db,
  dueAt,
  payload,
  signal,
  logger,
  scheduleContinuation,
}) => {
  const paused = payload?.["paused"] ?? false;
  if (typeof paused !== "boolean") {
    panic("Request receipt retention pause setting must be boolean");
  }
  const deleted = await drainRequestReceipts({
    paused,
    signal,
    scheduleContinuation: () => scheduleContinuation(dueAt.claimedAtDate()),
    now: () => performance.now(),
    sweep: async (deadline) =>
      await sweepExpiredRequestReceipts({
        db,
        now: dueAt.claimedAtDate(),
        signal,
        deadline,
      }),
  });
  logger.info("scheduler.request_receipts_swept", {
    "requestReceipts.deleted": deleted,
  });
};
