import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  ActionAdmissionError,
  withActionAdmission,
} from "@/api/lib/rate-limit/action-admission";
import { DEMO_ACCOUNT_DAILY_ACTION_BUDGET } from "@/api/lib/rate-limit/demo-action-budget";
import { createRedisRateLimitRequestKey } from "@/api/lib/rate-limit/redis-context";

const organizationId = toSafeId<"organization">("org_demo");
const demoUser = toSafeId<"user">("user_demo");
const standardUser = toSafeId<"user">("user_standard");
const DAY_START_MS = Date.UTC(2026, 0, 15);
const NEXT_DAY_START_MS = Date.UTC(2026, 0, 16);

const policy = {
  organizationConcurrency: 10,
  userConcurrency: 10,
  leaseMs: 120_000,
};

const REQUEST_KEY_SEPARATOR = createRedisRateLimitRequestKey({
  counterKey: "",
  requestId: "",
});

// Fixed windows keyed like the shared store: one counter per counter key,
// expiring at the requested time, with refunds addressed by request key.
const windowCounter = () => {
  const windows = new Map<string, { count: number; expiresAt: number }>();
  const counterKeyOf = (key: string) =>
    key.slice(0, key.lastIndexOf(REQUEST_KEY_SEPARATOR));
  return {
    increment: (key: string, duration = 0, requestTime = 0) => {
      const counterKey = counterKeyOf(key);
      const current = windows.get(counterKey);
      const window =
        current !== undefined && current.expiresAt > requestTime
          ? { count: current.count + 1, expiresAt: current.expiresAt }
          : { count: 1, expiresAt: requestTime + duration };
      windows.set(counterKey, window);
      return {
        count: window.count,
        nextReset: new Date(window.expiresAt),
        start: requestTime,
      };
    },
    decrement: (key: string) => {
      const window = windows.get(counterKeyOf(key));
      if (window !== undefined && window.count > 0) {
        window.count -= 1;
      }
    },
  };
};

const demoBudget = () => {
  const counter = windowCounter();
  let now = DAY_START_MS;
  let increments = 0;
  return {
    setNow: (time: number) => {
      now = time;
    },
    increments: () => increments,
    budget: {
      resolveDemoUserId: async () => await Promise.resolve(demoUser),
      counter: () => ({
        increment: (key: string, duration?: number, requestTime?: number) => {
          increments += 1;
          return counter.increment(key, duration, requestTime);
        },
        decrement: counter.decrement,
      }),
      now: () => now,
    },
  };
};

type Budget = ReturnType<typeof demoBudget>["budget"];

const disabledAction = async (budget: Budget, userId = demoUser) =>
  await withActionAdmission({
    organizationId,
    userId,
    enabled: false,
    demoActionBudget: budget,
    run: async () => await Promise.resolve("served"),
  });

const backgroundAction = async (budget: Budget) =>
  await withActionAdmission({
    organizationId,
    userId: demoUser,
    enabled: true,
    execution: "background-job",
    actionKind: "workflow.background",
    policy,
    redis: { send: async () => await Promise.resolve(1) },
    demoActionBudget: budget,
    run: async () => await Promise.resolve("served"),
  });

const exhaustWith = async (
  budget: Budget,
  action: (budget: Budget) => Promise<Result<string, unknown>>,
) => {
  for (let index = 0; index < DEMO_ACCOUNT_DAILY_ACTION_BUDGET.max; index++) {
    const admitted = await action(budget);
    expect(Result.isOk(admitted)).toBe(true);
  }
};

const expectDailyRefusal = (result: Result<string, unknown>) => {
  if (Result.isOk(result)) {
    throw new Error("Expected the daily budget to refuse the action");
  }
  expect(ActionAdmissionError.is(result.error)).toBe(true);
  expect(result.error).toMatchObject({
    reason: "daily_exhausted",
    code: "action_period_exhausted",
  });
};

describe("demo account daily action budget", () => {
  test("admits the daily maximum and refuses the next action even with admission disabled", async () => {
    const { budget } = demoBudget();
    await exhaustWith(budget, disabledAction);
    let calls = 0;
    const refused = await withActionAdmission({
      organizationId,
      userId: demoUser,
      enabled: false,
      demoActionBudget: budget,
      run: async () => {
        calls += 1;
        return await Promise.resolve("served");
      },
    });
    expectDailyRefusal(refused);
    expect(calls).toBe(0);
  });

  test("counts concurrency-only background actions against the same budget", async () => {
    const { budget } = demoBudget();
    await exhaustWith(budget, backgroundAction);
    expectDailyRefusal(await backgroundAction(budget));
    expectDailyRefusal(await disabledAction(budget));
  });

  test("leaves a standard account outside the budget", async () => {
    const tracked = demoBudget();
    for (
      let index = 0;
      index <= DEMO_ACCOUNT_DAILY_ACTION_BUDGET.max;
      index++
    ) {
      const admitted = await disabledAction(tracked.budget, standardUser);
      expect(Result.isOk(admitted)).toBe(true);
    }
    expect(tracked.increments()).toBe(0);
  });

  test("starts a fresh budget on the next UTC day", async () => {
    const tracked = demoBudget();
    tracked.setNow(NEXT_DAY_START_MS - DEMO_ACCOUNT_DAILY_ACTION_BUDGET.max);
    await exhaustWith(tracked.budget, disabledAction);
    expectDailyRefusal(await disabledAction(tracked.budget));
    tracked.setNow(NEXT_DAY_START_MS);
    expect(Result.isOk(await disabledAction(tracked.budget))).toBe(true);
  });

  test("counts a nested same-caller admission once", async () => {
    const tracked = demoBudget();
    const admitted = await withActionAdmission({
      organizationId,
      userId: demoUser,
      enabled: false,
      demoActionBudget: tracked.budget,
      run: async () => await disabledAction(tracked.budget),
    });
    expect(Result.isOk(admitted)).toBe(true);
    expect(tracked.increments()).toBe(1);
  });

  test("refunds an attempt refused before its work starts", async () => {
    const { budget } = demoBudget();
    for (
      let index = 0;
      index <= DEMO_ACCOUNT_DAILY_ACTION_BUDGET.max;
      index++
    ) {
      const busy = await withActionAdmission({
        organizationId,
        userId: demoUser,
        enabled: true,
        execution: "background-job",
        actionKind: "workflow.background",
        policy,
        redis: { send: async () => await Promise.resolve(0) },
        demoActionBudget: budget,
        run: async () => await Promise.resolve("served"),
      });
      if (Result.isOk(busy)) {
        throw new Error("Expected a busy refusal");
      }
      expect(busy.error).toMatchObject({ reason: "busy" });
    }
    await exhaustWith(budget, disabledAction);
    expectDailyRefusal(await disabledAction(budget));
  });
});
