import { describe, expect, test } from "bun:test";

import { DEFAULT_LOCK_RETRY_CONFIG } from "./lock-retry-ladder";
import {
  SCHEDULER_DRAIN_DEADLINE_MS,
  SCHEDULER_DRAIN_PAUSE_BOUND_MS,
  SCHEDULER_DRAIN_PAUSE_FLOOR_MS,
} from "./migration-scheduler-drain";

describe("scheduler drain bounds", () => {
  test("every pause outlasts the drain and the lock-wait ladder, and the step's own pause stays above the floor", () => {
    expect(SCHEDULER_DRAIN_PAUSE_FLOOR_MS).toBeGreaterThan(
      SCHEDULER_DRAIN_DEADLINE_MS + DEFAULT_LOCK_RETRY_CONFIG.budgetMs,
    );
    expect(SCHEDULER_DRAIN_PAUSE_BOUND_MS).toBeGreaterThan(
      SCHEDULER_DRAIN_PAUSE_FLOOR_MS,
    );
  });
});
