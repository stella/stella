import { LIMITS } from "@/api/lib/limits";

const WORK_POOLS = ["heavy-sidecar", "file-scan", "pdf-render"] as const;
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
  "pdf-render": {
    slots: LIMITS.workPoolPdfRenderSlots,
    // The slot is the bound: one source of any admitted size runs alone.
    bytes: LIMITS.fileDerivativeSourceMaxBytes,
    maxWaiters: LIMITS.workPoolPdfRenderMaxWaiters,
    maxWaitMs: LIMITS.workPoolPdfRenderMaxWaitMs,
    // The worker's own timeout stops it first; the deadline kills a run
    // that outlives that by more than the worker's start-up.
    deadlineMs: LIMITS.pdfRenderTimeoutMs + 10_000,
    // The memory a render uses is the worker's, which this process's RSS
    // does not show; the worker's ceiling bounds it instead.
    memoryCloseAt: Number.POSITIVE_INFINITY,
  },
} as const satisfies Record<WorkPool, WorkPoolLimits>;
