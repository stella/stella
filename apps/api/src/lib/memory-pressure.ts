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
