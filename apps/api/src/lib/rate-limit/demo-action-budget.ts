import { Result } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { DAY_IN_MS, Temporal } from "@stll/time";

import { getDemoAccountConfig } from "@/api/lib/auth/demo-account";
import type { SafeId } from "@/api/lib/branded-types";
import { ActionAdmissionError } from "@/api/lib/errors/action-admission-error";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import type { RateLimitContext } from "@/api/lib/rate-limit/rate-limit";
import {
  createRedisRateLimitRequestKey,
  RedisRateLimitContext,
} from "@/api/lib/rate-limit/redis-context";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

export const DEMO_ACCOUNT_DAILY_ACTION_BUDGET = {
  max: 200,
  durationMs: DAY_IN_MS,
} as const;

const REFUND_FAILURE = failureSink({
  event: "action_admission.demo_refund_failed",
  expected: [],
});
const COUNTER_FAILURE = failureSink({
  event: "action_admission.demo_counter_failed",
  expected: [],
});

type DemoActionCounter = Pick<
  RateLimitContext,
  "complete" | "increment" | "decrement"
>;

export type DemoActionBudget = {
  resolveDemoUserId: () => Promise<SafeId<"user"> | undefined>;
  counter: () => DemoActionCounter;
  now: () => number;
};

type DemoActionCaller = {
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
};

type DemoActionScope = DemoActionCaller & { status: "active" | "settled" };

const demoActionScope = new AsyncLocalStorage<DemoActionScope>();

// Every admission resolves the demo account, so a lookup (found or not) is
// reused briefly; expiry picks up an account created or replaced later.
const DEMO_USER_ID_CACHE_MS = 5 * 60 * 1000;

let resolvedDemoUser:
  | { userId: SafeId<"user"> | undefined; expiresAtMs: number }
  | undefined;

const resolveConfiguredDemoUserId = async () => {
  const { email } = getDemoAccountConfig();
  if (email === undefined) {
    return undefined;
  }
  const nowMs = Temporal.Now.instant().epochMilliseconds;
  if (resolvedDemoUser !== undefined && resolvedDemoUser.expiresAtMs > nowMs) {
    return resolvedDemoUser.userId;
  }
  const { findAccountIdByEmail } = await import("@/api/lib/db/account-row");
  const accountId = await findAccountIdByEmail(email);
  const userId =
    accountId === undefined ? undefined : brandPersistedUserId(accountId);
  resolvedDemoUser = { userId, expiresAtMs: nowMs + DEMO_USER_ID_CACHE_MS };
  return userId;
};

let demoActionCounter: RedisRateLimitContext | undefined;

const getDemoActionCounter = () => {
  demoActionCounter ??= new RedisRateLimitContext({
    failurePolicy: "fail_open_local",
    // The store reports a failed refund here instead of rejecting. The lost
    // refund costs one action until the day's counter expires at reset.
    onRedisError: (error, operation) => {
      if (operation === "decrement") {
        observeFailure(error, { sink: REFUND_FAILURE });
        return;
      }
      observeFailure(error, { sink: COUNTER_FAILURE });
    },
  });
  return demoActionCounter;
};

export const configuredDemoActionBudget: DemoActionBudget = {
  resolveDemoUserId: resolveConfiguredDemoUserId,
  counter: getDemoActionCounter,
  now: () => Temporal.Now.instant().epochMilliseconds,
};

type WithDemoActionBudgetOptions<T> = DemoActionCaller & {
  budget: DemoActionBudget;
  scope: "inherit" | "independent";
  run: (markStarted: () => void) => Promise<Result<T, unknown>>;
};

const refund = async (counter: DemoActionCounter, key: string) => {
  const refunded = await Result.tryPromise({
    try: async () => await counter.decrement(key),
    catch: (cause: unknown) => cause,
  });
  if (Result.isError(refunded)) {
    observeFailure(refunded.error, { sink: REFUND_FAILURE });
  }
};

const complete = async (counter: DemoActionCounter, key: string) => {
  const completed = await Result.tryPromise({
    try: async () => await counter.complete(key),
    catch: (cause: unknown) => cause,
  });
  if (Result.isError(completed)) {
    observeFailure(completed.error, { sink: COUNTER_FAILURE });
  }
};

/**
 * Counts each action the configured demo account starts per UTC day. A nested
 * same-caller admission belongs to its enclosing action and is not counted
 * again; an attempt refused by this budget or before its work starts is
 * refunded, so refusals never consume budget.
 */
export const withDemoActionBudget = async <T>({
  budget,
  organizationId,
  userId,
  scope,
  run,
}: WithDemoActionBudgetOptions<T>): Promise<Result<T, unknown>> => {
  const enclosing = demoActionScope.getStore();
  if (
    scope === "inherit" &&
    enclosing?.status === "active" &&
    enclosing.organizationId === organizationId &&
    enclosing.userId === userId
  ) {
    return await run(() => undefined);
  }
  const demoUserId = await Result.tryPromise({
    try: async () => await budget.resolveDemoUserId(),
    catch: (cause: unknown) =>
      new ActionAdmissionError({
        message: "Action admission is unavailable",
        reason: "unavailable",
        cause,
      }),
  });
  if (Result.isError(demoUserId)) {
    return demoUserId;
  }
  if (demoUserId.value !== userId) {
    return await run(() => undefined);
  }

  const counter = budget.counter();
  const nowMs = budget.now();
  const day = Math.floor(nowMs / DEMO_ACCOUNT_DAILY_ACTION_BUDGET.durationMs);
  const dayEndMs = (day + 1) * DEMO_ACCOUNT_DAILY_ACTION_BUDGET.durationMs;
  const key = createRedisRateLimitRequestKey({
    counterKey: `demo-account-actions:${userId}:${day}`,
    requestId: Bun.randomUUIDv7(),
  });
  const counted = await Result.tryPromise({
    try: async () => await counter.increment(key, dayEndMs - nowMs, nowMs),
    catch: (cause: unknown) =>
      new ActionAdmissionError({
        message: "Action admission is unavailable",
        reason: "unavailable",
        cause,
      }),
  });
  if (Result.isError(counted)) {
    await complete(counter, key);
    return counted;
  }
  try {
    if (counted.value.count > DEMO_ACCOUNT_DAILY_ACTION_BUDGET.max) {
      await refund(counter, key);
      return Result.err(
        new ActionAdmissionError({
          message: "Daily action limit reached",
          reason: "daily_exhausted",
          retryAtMs: dayEndMs,
        }),
      );
    }

    const executionScope: DemoActionScope = {
      organizationId,
      userId,
      status: "active",
    };
    const execution: { phase: "waiting" | "started" } = { phase: "waiting" };
    try {
      return await demoActionScope.run(
        executionScope,
        async () =>
          await run(() => {
            execution.phase = "started";
          }),
      );
    } finally {
      executionScope.status = "settled";
      if (execution.phase === "waiting") {
        await refund(counter, key);
      }
    }
  } finally {
    await complete(counter, key);
  }
};
