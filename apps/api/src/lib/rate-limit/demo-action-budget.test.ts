import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import {
  ActionAdmissionError,
  withActionAdmission,
} from "@/api/lib/rate-limit/action-admission";
import { DEMO_ACCOUNT_DAILY_ACTION_BUDGET } from "@/api/lib/rate-limit/demo-action-budget";
import { createTestDemoActionBudget } from "@/api/tests/helpers/demo-action-budget";

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

const demoBudget = () =>
  createTestDemoActionBudget({ demoUserId: demoUser, nowMs: DAY_START_MS });

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

const expectDailyRefusal = (
  result: Result<string, unknown>,
  retryAtMs = NEXT_DAY_START_MS,
) => {
  if (Result.isOk(result)) {
    throw new Error("Expected the daily budget to refuse the action");
  }
  expect(ActionAdmissionError.is(result.error)).toBe(true);
  expect(result.error).toMatchObject({
    reason: "daily_exhausted",
    code: "action_period_exhausted",
    retryAtMs,
  });
};

describe("demo account daily action budget", () => {
  test("admits the daily maximum and refuses the next action even with admission disabled", async () => {
    const tracked = demoBudget();
    const { budget } = tracked;
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
    expect(tracked.completions()).toBe(
      DEMO_ACCOUNT_DAILY_ACTION_BUDGET.max + 1,
    );
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

  test("completes started success, started failure, and unstarted refund attempts", async () => {
    const tracked = demoBudget();
    const success = await withActionAdmission({
      organizationId,
      userId: demoUser,
      enabled: false,
      demoActionBudget: tracked.budget,
      run: async () => await Promise.resolve("served"),
    });
    expect(Result.isOk(success)).toBe(true);

    const failure = await withActionAdmission({
      organizationId,
      userId: demoUser,
      enabled: false,
      demoActionBudget: tracked.budget,
      run: async () => {
        throw new Error("Synthetic started action failure");
      },
    });
    expect(Result.isError(failure)).toBe(true);

    const refusedBeforeStart = await withActionAdmission({
      organizationId,
      userId: demoUser,
      enabled: true,
      execution: "background-job",
      actionKind: "workflow.background",
      policy,
      redis: { send: async () => await Promise.resolve(0) },
      demoActionBudget: tracked.budget,
      run: async () => await Promise.resolve("unreachable"),
    });
    expect(Result.isError(refusedBeforeStart)).toBe(true);
    expect(refusedBeforeStart).toMatchObject({
      error: { reason: "busy" },
    });

    expect(tracked.increments()).toBe(3);
    expect(tracked.completions()).toBe(3);
    expect(tracked.count()).toBe(2);
  });

  test("completes an increment failure to clear an uncertain refund marker", async () => {
    let completions = 0;
    const unavailable = await withActionAdmission({
      organizationId,
      userId: demoUser,
      enabled: false,
      demoActionBudget: {
        resolveDemoUserId: async () => await Promise.resolve(demoUser),
        counter: () => ({
          increment: async () => {
            throw new Error("Synthetic ambiguous increment failure");
          },
          decrement: async () => await Promise.resolve(),
          complete: async () => {
            completions += 1;
          },
        }),
        now: () => DAY_START_MS,
      },
      run: async () => await Promise.resolve("unreachable"),
    });
    expect(unavailable).toMatchObject({
      error: { reason: "unavailable" },
    });
    expect(completions).toBe(1);
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

  test("refused attempts never consume budget, even concurrently", async () => {
    const tracked = demoBudget();
    await exhaustWith(tracked.budget, disabledAction);
    let calls = 0;
    const attempts = await Promise.all(
      Array.from(
        { length: 25 },
        async () =>
          await withActionAdmission({
            organizationId,
            userId: demoUser,
            enabled: false,
            demoActionBudget: tracked.budget,
            run: async () => {
              calls += 1;
              return await Promise.resolve("served");
            },
          }),
      ),
    );
    for (const attempt of attempts) {
      expectDailyRefusal(attempt);
    }
    expect(calls).toBe(0);
    expect(tracked.count()).toBe(DEMO_ACCOUNT_DAILY_ACTION_BUDGET.max);
  });

  test("concurrent attempts around the limit admit exactly the remaining budget", async () => {
    const tracked = demoBudget();
    const remaining = 3;
    for (
      let index = 0;
      index < DEMO_ACCOUNT_DAILY_ACTION_BUDGET.max - remaining;
      index++
    ) {
      expect(Result.isOk(await disabledAction(tracked.budget))).toBe(true);
    }
    const attempts = await Promise.all(
      Array.from(
        { length: 10 },
        async () => await disabledAction(tracked.budget),
      ),
    );
    expect(attempts.filter((attempt) => Result.isOk(attempt))).toHaveLength(
      remaining,
    );
    expect(tracked.count()).toBe(DEMO_ACCOUNT_DAILY_ACTION_BUDGET.max);
  });
});
