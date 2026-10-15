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
    read: (): { cause: MemoryPressureCause; rssBytes: number } => {
      const rssBytes = readRssBytes();
      if (lastSignalAt !== null && now() - lastSignalAt < holdMs) {
        return { cause: "signal", rssBytes };
      }
      return { cause: rssBytes >= rssHighBytes ? "rss" : null, rssBytes };
    },
  };
};

export type MemoryPressureGate = ReturnType<typeof createMemoryPressureGate>;
