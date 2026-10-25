import { panic } from "better-result";

type WorkBudgetRefusal = {
  type: "refused";
  reason: "busy" | "memory" | "aborted";
  retryAfterMs: number;
};

type WorkBudgetAdmission = {
  type: "admitted";
  release: () => void;
};

export type WorkBudgetResult = WorkBudgetAdmission | WorkBudgetRefusal;

type WorkBudgetRequest = {
  slots?: number;
  bytes?: number;
  signal?: AbortSignal;
};
type Waiter = {
  slots: number;
  bytes: number;
  signal: AbortSignal | undefined;
  finish: (result: WorkBudgetResult) => void;
  timer: ReturnType<typeof setTimeout>;
  onAbort: () => void;
};

// Memory recovery raises no event, so a queue held back by memory pressure
// re-reads it on this interval until the queue drains or empties.
const MEMORY_RECHECK_MS = 250;

type CreateWorkBudgetOptions = {
  slots: number;
  bytes: number;
  maxWaiters: number;
  maxWaitMs: number;
  memoryOpen?: (() => boolean) | undefined;
  memoryRecheckMs?: number | undefined;
};

export const createWorkBudget = ({
  slots: slotCapacity,
  bytes: byteCapacity,
  maxWaiters,
  maxWaitMs,
  memoryOpen = () => true,
  memoryRecheckMs = MEMORY_RECHECK_MS,
}: CreateWorkBudgetOptions) => {
  let slotsInUse = 0;
  let bytesInUse = 0;
  const waiters: Waiter[] = [];
  let memoryRecheck: ReturnType<typeof setTimeout> | undefined;

  const fits = (slots: number, bytes: number) =>
    slotsInUse === 0 ||
    (slotsInUse + slots <= slotCapacity && bytesInUse + bytes <= byteCapacity);

  const releaseFor = (slots: number, bytes: number) => {
    let released = false;
    return () => {
      if (released) {
        panic("Work admission was released twice");
      }
      released = true;
      slotsInUse -= slots;
      bytesInUse -= bytes;
      drain();
    };
  };

  const remove = (waiter: Waiter) => {
    const index = waiters.indexOf(waiter);
    if (index === -1) {
      return false;
    }
    waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    return true;
  };

  const admit = (waiter: Waiter) => {
    remove(waiter);
    slotsInUse += waiter.slots;
    bytesInUse += waiter.bytes;
    waiter.finish({
      type: "admitted",
      release: releaseFor(waiter.slots, waiter.bytes),
    });
  };

  const scheduleMemoryRecheck = () => {
    if (memoryRecheck !== undefined) {
      return;
    }
    memoryRecheck = setTimeout(() => {
      memoryRecheck = undefined;
      drain();
    }, memoryRecheckMs);
  };

  function drain() {
    for (let next = waiters.at(0); next !== undefined; next = waiters.at(0)) {
      if (!memoryOpen()) {
        scheduleMemoryRecheck();
        return;
      }
      if (!fits(next.slots, next.bytes)) {
        return;
      }
      admit(next);
    }
  }

  const acquire = async ({
    slots = 1,
    bytes = 0,
    signal,
  }: WorkBudgetRequest): Promise<WorkBudgetResult> => {
    if (signal?.aborted) {
      return { type: "refused", reason: "aborted", retryAfterMs: 0 };
    }
    if (!memoryOpen()) {
      return { type: "refused", reason: "memory", retryAfterMs: maxWaitMs };
    }
    // Waiters held back while memory was closed go first.
    drain();
    if (waiters.length === 0 && fits(slots, bytes)) {
      slotsInUse += slots;
      bytesInUse += bytes;
      return { type: "admitted", release: releaseFor(slots, bytes) };
    }
    if (waiters.length >= maxWaiters) {
      return { type: "refused", reason: "busy", retryAfterMs: maxWaitMs };
    }
    return await new Promise((resolve) => {
      const waiter: Waiter = {
        slots,
        bytes,
        signal,
        finish: resolve,
        timer: setTimeout(() => {
          if (!remove(waiter)) {
            return;
          }
          const reason = memoryOpen() ? "busy" : "memory";
          resolve({ type: "refused", reason, retryAfterMs: maxWaitMs });
          drain();
        }, maxWaitMs),
        onAbort: () => undefined,
      };
      waiter.onAbort = () => {
        if (!remove(waiter)) {
          return;
        }
        resolve({ type: "refused", reason: "aborted", retryAfterMs: 0 });
        drain();
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      waiters.push(waiter);
    });
  };

  return {
    acquire,
    stats: () => ({
      inFlight: slotsInUse,
      queued: waiters.length,
      bytesInFlight: bytesInUse,
    }),
  };
};

export type WorkBudget = ReturnType<typeof createWorkBudget>;
