import { panic, Result } from "better-result";

import { backoffDelay } from "@stll/concurrency/backoff-delay";

import { isPgError, PG_ERROR } from "../lib/pg-error";

export type LockRetryConfig = {
  lockTimeoutsMs: readonly number[];
  pauseBaseMs: number;
  pauseCapMs: number;
  budgetMs: number;
};

/** Short queue visits, with room for an autovacuum to finish between visits. */
export const DEFAULT_LOCK_RETRY_CONFIG = {
  lockTimeoutsMs: [100, 250, 500, 1000, 2000],
  pauseBaseMs: 100,
  pauseCapMs: 2000,
  budgetMs: 120_000,
} as const satisfies LockRetryConfig;

export type LockRetryRuntime = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
};

export const DEFAULT_LOCK_RETRY_RUNTIME: LockRetryRuntime = {
  now: () => performance.now(),
  sleep: Bun.sleep,
  random: Math.random,
};

type LockRetryPlan =
  | { type: "retry"; lockTimeoutMs: number; pauseMs: number }
  | { type: "stop"; reason: "exhausted" | "budget_spent" };

type PlanLockRetryOptions = {
  config: LockRetryConfig;
  /** One-based attempt, including the initial execution. */
  attempt: number;
  elapsedMs: number;
  /** A sample in [0, 1]. */
  random: number;
};

/** Reserves the full queue wait plus pause; elapsed time must be monotonic. */
export const planLockRetry = ({
  config,
  attempt,
  elapsedMs,
  random,
}: PlanLockRetryOptions): LockRetryPlan => {
  const { lockTimeoutsMs, pauseBaseMs, pauseCapMs, budgetMs } = config;
  if (
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    !Number.isFinite(random) ||
    random < 0 ||
    random > 1 ||
    !Number.isFinite(budgetMs) ||
    budgetMs < 0 ||
    !Number.isFinite(pauseBaseMs) ||
    pauseBaseMs < 0 ||
    !Number.isFinite(pauseCapMs) ||
    pauseCapMs < 0 ||
    lockTimeoutsMs.length === 0 ||
    lockTimeoutsMs.some(
      (timeout, index) =>
        !Number.isInteger(timeout) ||
        timeout <= 0 ||
        (index > 0 && timeout < (lockTimeoutsMs.at(index - 1) ?? timeout)),
    )
  ) {
    return panic("Invalid lock retry ladder configuration or planning input");
  }
  const lockTimeoutMs = lockTimeoutsMs.at(attempt - 1);
  if (lockTimeoutMs === undefined) {
    return { type: "stop", reason: "exhausted" };
  }
  // Reserve the ceiling, rather than the sample, so a budget stop stays final.
  const pauseCeilingMs =
    attempt === 1
      ? 0
      : backoffDelay(attempt - 2, {
          baseMs: pauseBaseMs,
          maxMs: pauseCapMs,
        });
  if (elapsedMs + pauseCeilingMs + lockTimeoutMs > budgetMs) {
    return { type: "stop", reason: "budget_spent" };
  }
  return {
    type: "retry",
    lockTimeoutMs,
    pauseMs: pauseCeilingMs * random,
  };
};

type LockRetryDetails = {
  attempts: number;
  lockTimeoutMs: number;
  cause: unknown;
};

type RunLockRetryOptions = LockRetryRuntime & {
  config: LockRetryConfig;
  attempt: (lockTimeoutMs: number, attempt: number) => Promise<void>;
  beforeRetry?: (
    details: LockRetryDetails & { pauseMs: number },
  ) => Promise<void>;
};

type LockRetryOutcome =
  | { type: "complete" }
  | (LockRetryDetails & { type: "stop"; reason: "exhausted" | "budget_spent" });

/** Only 55P03 retries. The caller owns transaction rollback and replay safety. */
export const runLockRetryLadder = async ({
  config,
  attempt,
  now,
  sleep,
  random,
  beforeRetry,
}: RunLockRetryOptions): Promise<LockRetryOutcome> => {
  const startedAt = now();
  let last: LockRetryDetails = {
    attempts: 0,
    lockTimeoutMs: 0,
    cause: undefined,
  };
  for (;;) {
    const nextAttempt = last.attempts + 1;
    const plan = planLockRetry({
      config,
      attempt: nextAttempt,
      elapsedMs: now() - startedAt,
      random: random(),
    });
    if (plan.type === "stop") {
      return { type: "stop", reason: plan.reason, ...last };
    }
    if (last.attempts > 0) {
      await beforeRetry?.({ ...last, pauseMs: plan.pauseMs });
      await sleep(plan.pauseMs);
      // Hooks and schedulers consume budget too; never start a late attempt.
      if (now() - startedAt + plan.lockTimeoutMs > config.budgetMs) {
        return { type: "stop", reason: "budget_spent", ...last };
      }
    }
    const outcome = await Result.tryPromise({
      try: async () => await attempt(plan.lockTimeoutMs, nextAttempt),
      catch: (cause) => cause,
    });
    if (outcome.isOk()) {
      return { type: "complete" };
    }
    if (!isPgError(outcome.error, PG_ERROR.LOCK_NOT_AVAILABLE)) {
      throw outcome.error;
    }
    last = {
      attempts: nextAttempt,
      lockTimeoutMs: plan.lockTimeoutMs,
      cause: outcome.error,
    };
  }
};
