import { Result } from "better-result";

import { detached } from "@/api/lib/analytics/capture";

type ObservationBufferOptions<T> = {
  capacity: number;
  batchSize: number;
  write: (batch: T[]) => Promise<void>;
  onFailure: (error: unknown, dropped: number) => void;
  onOverflow: () => void;
};

// Observations are best effort: the queue bounds memory even during a DB outage.
export const createObservationBuffer = <T>({
  capacity,
  batchSize,
  write,
  onFailure,
  onOverflow,
}: ObservationBufferOptions<T>) => {
  const pending: T[] = [];
  let active: Promise<void> | undefined;
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let inFlight = 0;
  const FLUSH_DELAY_MS = 25;
  const flush = async (): Promise<void> => {
    if (scheduled !== undefined) {
      clearTimeout(scheduled);
      scheduled = undefined;
    }
    if (active !== undefined) {
      await active;
      await flush();
      return;
    }
    active = (async () => {
      while (pending.length > 0) {
        const batch = pending.splice(0, batchSize);
        inFlight = batch.length;
        const outcome = await Result.tryPromise({
          try: async () => await write(batch),
          catch: (error: unknown) => error,
        });
        inFlight = 0;
        if (Result.isError(outcome)) {
          onFailure(outcome.error, batch.length);
        }
      }
    })();
    await active;
    active = undefined;
    if (pending.length > 0) {
      await flush();
    }
  };
  const enqueue = (observation: T): void => {
    if (pending.length + inFlight >= capacity) {
      onOverflow();
      return;
    }
    pending.push(observation);
    if (scheduled !== undefined || active !== undefined) {
      return;
    }
    scheduled = setTimeout(() => {
      scheduled = undefined;
      detached(flush, "action-cost.flush", (error) => {
        onFailure(error, pending.length + inFlight);
      });
    }, FLUSH_DELAY_MS);
  };
  return { enqueue, flush };
};
