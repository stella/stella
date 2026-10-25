import { LIMITS } from "@/api/lib/limits";

const WORK_POOLS = ["heavy-sidecar", "file-scan"] as const;
export type WorkPool = (typeof WORK_POOLS)[number];

export type WorkPoolLimits = {
  slots: number;
  bytes: number;
  maxWaiters: number;
  maxWaitMs: number;
  deadlineMs: number;
  memoryCloseAt: number;
};

export const WORK_POOL_LIMITS = {
  "heavy-sidecar": {
    slots: LIMITS.workPoolHeavySidecarSlots,
    bytes: LIMITS.workPoolHeavySidecarBytes,
    maxWaiters: LIMITS.workPoolHeavySidecarMaxWaiters,
    maxWaitMs: LIMITS.workPoolHeavySidecarMaxWaitMs,
    deadlineMs: LIMITS.workPoolHeavySidecarDeadlineMs,
    memoryCloseAt: 0.6,
  },
  "file-scan": {
    slots: LIMITS.workPoolFileScanSlots,
    bytes: LIMITS.workPoolFileScanBytes,
    maxWaiters: LIMITS.workPoolFileScanMaxWaiters,
    maxWaitMs: LIMITS.workPoolFileScanMaxWaitMs,
    deadlineMs: LIMITS.workPoolFileScanDeadlineMs,
    // Scans already hold the upload's bytes; the slot bounds their CPU, and
    // refusing on memory would fail ordinary uploads on a busy process.
    memoryCloseAt: Number.POSITIVE_INFINITY,
  },
} as const satisfies Record<WorkPool, WorkPoolLimits>;
