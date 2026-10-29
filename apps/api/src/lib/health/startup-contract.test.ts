import { expect, test } from "bun:test";

import {
  API_HEALTH_CHECK_GRACE_PERIOD_MS,
  SANCTIONS_STARTUP_WARMUP_BUDGET_MS,
  STARTUP_HEALTH_CHECK_MARGIN_MS,
} from "@/api/lib/health/startup-contract";

test("deployment grace exceeds the sanctions budget and recovery margin", () => {
  expect(API_HEALTH_CHECK_GRACE_PERIOD_MS).toBeGreaterThan(
    SANCTIONS_STARTUP_WARMUP_BUDGET_MS + STARTUP_HEALTH_CHECK_MARGIN_MS,
  );
});
