import { LIMITS } from "@/api/lib/limits";

const WORK_POOLS = ["heavy-sidecar"] as const;
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
} as const satisfies Record<WorkPool, WorkPoolLimits>;
