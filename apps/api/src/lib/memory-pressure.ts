export type MemoryPressureLevel = "warning" | "critical";

type ReconstructibleCache = {
  clear: () => number;
};

type MemoryPressureEvent = {
  evictedEntries: number;
  level: MemoryPressureLevel;
};

type CreateMemoryPressureHandlerOptions = {
  caches: readonly ReconstructibleCache[];
  onEviction: (event: MemoryPressureEvent) => void;
};

/** Build the process-boundary handler without registering module-level effects. */
export const createMemoryPressureHandler =
  ({ caches, onEviction }: CreateMemoryPressureHandlerOptions) =>
  (level: MemoryPressureLevel) => {
    let evictedEntries = 0;
    for (const cache of caches) {
      evictedEntries += cache.clear();
    }
    onEviction({ evictedEntries, level });
  };

/** Why a gate reads as under pressure, or `null` when it does not. */
export type MemoryPressureCause = "signal" | "rss" | null;

type CreateMemoryPressureGateOptions = {
  /** How long one operating-system pressure signal keeps the gate closed. */
  holdMs: number;
  now: () => number;
  readRssBytes: () => number;
  /** Resident set size at or above which the gate reads as under pressure. */
  rssHighBytes: number;
};

/**
 * Admission check for memory-heavy background work. The operating system's
 * `memoryPressure` event is edge-triggered (and absent where the kernel
 * cannot deliver it), so the gate combines the time since the last signal
 * with the process's own resident set size.
 */
export const createMemoryPressureGate = ({
  holdMs,
  now,
  readRssBytes,
  rssHighBytes,
}: CreateMemoryPressureGateOptions) => {
  let lastSignalAt: number | null = null;
  return {
    /** Record one `memoryPressure` signal; any level closes the gate. */
    record: (_level: MemoryPressureLevel) => {
      lastSignalAt = now();
    },
    read: (
      admittedBytes = 0,
    ): { cause: MemoryPressureCause; rssBytes: number } => {
      const rssBytes = readRssBytes();
      if (lastSignalAt !== null && now() - lastSignalAt < holdMs) {
        return { cause: "signal", rssBytes };
      }
      return {
        cause: rssBytes + admittedBytes >= rssHighBytes ? "rss" : null,
        rssBytes,
      };
    },
  };
};

export type MemoryPressureGate = ReturnType<typeof createMemoryPressureGate>;

type PressureReading = ReturnType<MemoryPressureGate["read"]>;

type CreatePressurePauseOptions = {
  gate: Pick<MemoryPressureGate, "read">;
  /** Stop taking new work; work already running continues. */
  pause: () => void;
  /** Take work again. */
  resume: () => void;
  /** How often a closed gate is re-read while consumption is paused. */
  recheckMs: number;
  onClose: (reading: PressureReading) => void;
  onOpen: (reading: PressureReading) => void;
  setTimer?: (run: () => void, ms: number) => () => void;
};

const unrefTimer = (run: () => void, ms: number): (() => void) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
};

/**
 * Pauses a consumer while its memory gate is closed, so pressure costs one
 * deferred job per closure instead of one per waiting job. The gate is then
 * re-read on this controller's own timer, and consumption resumes when it
 * opens; `onClose`/`onOpen` fire once per transition.
 */
export const createPressurePause = ({
  gate,
  onClose,
  onOpen,
  pause,
  recheckMs,
  resume,
  setTimer = unrefTimer,
}: CreatePressurePauseOptions) => {
  let cancelRecheck: (() => void) | null = null;
  const recheck = () => {
    const reading = gate.read();
    if (reading.cause === null) {
      cancelRecheck = null;
      onOpen(reading);
      resume();
      return;
    }
    cancelRecheck = setTimer(recheck, recheckMs);
  };
  return {
    /** Whether consumption is paused waiting for the gate to open. */
    isPaused: () => cancelRecheck !== null,
    /** Report that the gate was found closed; pauses on the first report. */
    closed: (reading: PressureReading) => {
      if (cancelRecheck !== null) {
        return;
      }
      onClose(reading);
      pause();
      cancelRecheck = setTimer(recheck, recheckMs);
    },
    stop: () => {
      cancelRecheck?.();
      cancelRecheck = null;
    },
  };
};

export type PressurePause = ReturnType<typeof createPressurePause>;
