import { describe, expect, test } from "bun:test";

import { DEFAULT_MAX_RUNTIME_MS } from "../lib/scheduler/timing";
import { DEFAULT_LOCK_RETRY_CONFIG } from "./lock-retry-ladder";
import {
  SCHEDULER_DRAIN_DEADLINE_MS,
  SCHEDULER_DRAIN_PAUSE_BOUND_MS,
  SCHEDULER_DRAIN_START_FLOOR_MS,
  SCHEDULER_DRAIN_WORK_FLOOR_MS,
} from "./migration-scheduler-drain";

// The database refuses a pause longer than this (scheduler_job_pause_bound).
const DATABASE_PAUSE_CAP_MS = 72 * 60 * 60_000;

describe("scheduler drain bounds", () => {
  test("the wait covers a job's runtime ceiling, and every pause covers the wait plus the work", () => {
    expect(SCHEDULER_DRAIN_DEADLINE_MS).toBeGreaterThan(DEFAULT_MAX_RUNTIME_MS);
    expect(SCHEDULER_DRAIN_WORK_FLOOR_MS).toBeGreaterThan(
      DEFAULT_LOCK_RETRY_CONFIG.budgetMs,
    );
    expect(SCHEDULER_DRAIN_START_FLOOR_MS).toBe(
      SCHEDULER_DRAIN_DEADLINE_MS + SCHEDULER_DRAIN_WORK_FLOOR_MS,
    );
    expect(SCHEDULER_DRAIN_PAUSE_BOUND_MS).toBeGreaterThan(
      SCHEDULER_DRAIN_START_FLOOR_MS,
    );
    expect(SCHEDULER_DRAIN_PAUSE_BOUND_MS).toBeLessThan(DATABASE_PAUSE_CAP_MS);
  });
});
