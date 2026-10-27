const BYTES_PER_MIB = 1024 * 1024;

// The retired API RSS workflow measured the heaviest PGlite-backed suite on
// ubuntu24 x64, then reserved a 3 GiB per-worker peak budget for suite overlap.
export const API_TEST_WORKER_PEAK_MIB = 3072;

type DeriveApiTestWorkerCountOptions = {
  availableParallelism: number;
  totalMemoryBytes: number;
};

/**
 * Bound Bun's parallel workers by both CPU capacity and the number of
 * worst-case suites that fit in physical memory.
 */
export const deriveApiTestWorkerCount = ({
  availableParallelism,
  totalMemoryBytes,
}: DeriveApiTestWorkerCountOptions): number => {
  const coreWorkers = Math.floor(availableParallelism) - 1;
  const memoryWorkers = Math.floor(
    totalMemoryBytes / BYTES_PER_MIB / API_TEST_WORKER_PEAK_MIB,
  );
  return Math.max(1, Math.min(coreWorkers, memoryWorkers));
};
