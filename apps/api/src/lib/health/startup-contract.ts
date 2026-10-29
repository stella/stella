export type StartupDurationMs = number;

/** Background sanctions warming stops delaying its own startup lifecycle here. */
export const SANCTIONS_STARTUP_WARMUP_BUDGET_MS: StartupDurationMs = 60_000;

/** API service deployment health-check grace period. */
export const API_HEALTH_CHECK_GRACE_PERIOD_MS: StartupDurationMs = 180_000;

/** Leave enough time after the warm-up budget for deployment probes to recover. */
export const STARTUP_HEALTH_CHECK_MARGIN_MS: StartupDurationMs = 30_000;
