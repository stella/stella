import { panic, Result } from "better-result";

import { detached } from "@/api/lib/analytics/capture";

type ObservationBufferOptions<T> = {
  capacity: number;
  batchSize: number;
  write: (batch: T[]) => Promise<void>;
  onFailure: (error: unknown, dropped: number) => void;
  onOverflow: () => void;
};

type DrainState =
  | { type: "idle" }
  | { type: "scheduled"; timer: ReturnType<typeof setTimeout> }
  | { type: "draining"; done: Promise<void> };

// Observations are best effort: the queue bounds memory even during a DB outage.
export const createObservationBuffer = <T>({
  capacity,
  batchSize,
  write,
  onFailure,
  onOverflow,
}: ObservationBufferOptions<T>) => {
  const pending: T[] = [];
  let drain: DrainState = { type: "idle" };
  let inFlight = 0;
  const FLUSH_DELAY_MS = 25;
  const writeAll = async () => {
    try {
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
    } finally {
      inFlight = 0;
    }
  };
  const flush = async (): Promise<void> => {
    switch (drain.type) {
      case "draining":
        await drain.done;
        await flush();
        return;
      case "scheduled":
        clearTimeout(drain.timer);
        break;
      case "idle":
        break;
      default:
        drain satisfies never;
        return panic("Unhandled observation buffer drain state");
    }
    const done = writeAll();
    drain = { type: "draining", done };
    try {
      await done;
    } finally {
      // A throwing callback must not leave the buffer draining forever.
      drain = { type: "idle" };
    }
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
    if (drain.type !== "idle") {
      return;
    }
    drain = {
      type: "scheduled",
      timer: setTimeout(() => {
        detached(flush, "action-cost.flush", (error) => {
          onFailure(error, pending.length + inFlight);
        });
      }, FLUSH_DELAY_MS),
    };
  };
  return { enqueue, flush };
};
