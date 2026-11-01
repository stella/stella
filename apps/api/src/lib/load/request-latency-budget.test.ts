import { describe, expect, test } from "bun:test";

import { readFailureBrand } from "@stll/errors";

import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import {
  remainingRequestBudgetMs,
  requestBoundedTimeoutMs,
  requestBudgetExpiry,
  runBoundedRequestStep,
  runWithinRequestLatencyBudget,
} from "@/api/lib/load/request-latency-budget";

/** A step that never settles: only a budget ends the wait. */
const never = async <T>(): Promise<T> =>
  await Promise.withResolvers<T>().promise;

describe("request latency budget", () => {
  test("leaves a timeout alone outside a request scope", () => {
    expect(remainingRequestBudgetMs()).toBeUndefined();
    expect(requestBoundedTimeoutMs(30_000)).toBe(30_000);
    expect(requestBoundedTimeoutMs(0)).toBe(0);
  });

  test("clamps a longer timeout to what is left of the request", () => {
    runWithinRequestLatencyBudget(
      { label: "search_legislation", budgetMs: 8000 },
      () => {
        const bounded = requestBoundedTimeoutMs(30_000);
        expect(bounded).toBeLessThanOrEqual(8000);
        expect(bounded).toBeGreaterThan(7000);
        expect(requestBoundedTimeoutMs(1500)).toBe(1500);
      },
    );
  });

  test("bounds a timeout of its own that has none", () => {
    runWithinRequestLatencyBudget(
      { label: "read_statute", budgetMs: 2000 },
      () => {
        expect(requestBoundedTimeoutMs(0)).toBeLessThanOrEqual(2000);
        expect(requestBoundedTimeoutMs(0)).toBeGreaterThan(0);
      },
    );
  });

  test("never reads a spent budget as no deadline", () => {
    // A zero budget is spent the moment the scope opens.
    runWithinRequestLatencyBudget(
      { label: "read_statute", budgetMs: 0 },
      () => {
        expect(remainingRequestBudgetMs()).toBe(0);
        expect(requestBoundedTimeoutMs(30_000)).toBe(1);
        expect(requestBoundedTimeoutMs(0)).toBe(1);
      },
    );
  });

  test("carries the scope through awaited work", async () => {
    await runWithinRequestLatencyBudget(
      { label: "search_case_law", budgetMs: 8000 },
      async () => {
        await Promise.resolve();
        const nested = await Promise.resolve().then(() =>
          requestBoundedTimeoutMs(30_000),
        );
        expect(nested).toBeLessThanOrEqual(8000);
      },
    );
  });
});

describe("request budget expiry", () => {
  const cause = new Error("statement cancelled");

  test("names nothing outside a scope, or for another failure while budget remains", () => {
    expect(
      requestBudgetExpiry(cause, { clampedTimeout: true }),
    ).toBeUndefined();
    runWithinRequestLatencyBudget(
      { label: "read_statute", budgetMs: 2000 },
      () => {
        expect(
          requestBudgetExpiry(cause, { clampedTimeout: false }),
        ).toBeUndefined();
      },
    );
  });

  test("names a clamped timeout that surfaces just before the deadline", () => {
    // The clamp floors to whole milliseconds, so the dependency can give up
    // while a fraction of the budget is left: provenance, not the clock,
    // makes it the budget's.
    runWithinRequestLatencyBudget(
      { label: "read_statute", budgetMs: 2000 },
      () => {
        expect(remainingRequestBudgetMs()).toBeGreaterThan(0);
        const expiry = requestBudgetExpiry(cause, { clampedTimeout: true });
        expect(expiry).toBeInstanceOf(TimeoutError);
        expect(readFailureBrand(expiry)).toEqual({
          reason: "timeout_budgeted",
          source: "instance",
        });
      },
    );
  });

  test("keeps a failure the caller does not attribute to the budget, even past the deadline", () => {
    runWithinRequestLatencyBudget(
      { label: "read_statute", budgetMs: 0 },
      () => {
        expect(
          requestBudgetExpiry(cause, { clampedTimeout: false }),
        ).toBeUndefined();
      },
    );
  });

  test("reports a clamped timeout as the budget's, cause kept", () => {
    const ended = new Error("connection ended by the server");
    runWithinRequestLatencyBudget(
      { label: "read_statute", budgetMs: 0 },
      () => {
        const expiry = requestBudgetExpiry(ended, { clampedTimeout: true });
        expect(expiry).toBeInstanceOf(TimeoutError);
        expect(expiry).toMatchObject({
          label: "read_statute",
          timeoutMs: 0, // timeout under test
          cause: ended,
        });
        expect(readFailureBrand(expiry)).toEqual({
          reason: "timeout_budgeted",
          source: "instance",
        });
      },
    );
  });

  test("counts the budget from the request's start, not from the scope", () => {
    runWithinRequestLatencyBudget(
      {
        label: "read_statute",
        budgetMs: 2000,
        startedAtMs: performance.now() - 1500,
      },
      () => {
        expect(requestBoundedTimeoutMs(30_000)).toBeLessThanOrEqual(500);
      },
    );
  });
});

describe("bounded request step", () => {
  test("answers the step's value when it completes in time", async () => {
    expect(
      await runBoundedRequestStep(async () => await Promise.resolve(42), {
        label: "step",
        budgetMs: 1000,
      }),
    ).toEqual({ status: "complete", value: 42 });
  });

  test("degrades at its sub-budget instead of waiting", async () => {
    const startedAt = performance.now();
    const step = await runBoundedRequestStep(never, {
      label: "court-list",
      budgetMs: 20,
    });
    expect(performance.now() - startedAt).toBeLessThan(1000);
    expect(step).toMatchObject({
      status: "degraded",
      reason: "budget_exhausted",
      budgetMs: 20,
    });
    // Graded as a budgeted wait, never as an unbounded timeout defect.
    expect(
      step.status === "degraded" ? readFailureBrand(step.error) : undefined,
    ).toEqual({ reason: "timeout_budgeted", source: "instance" });
  });

  test("degrades at the request's budget when that is the shorter", async () => {
    const step = await runWithinRequestLatencyBudget(
      { label: "search_case_law", budgetMs: 20 },
      async () =>
        await runBoundedRequestStep(never, {
          label: "court-list",
          budgetMs: 60_000,
        }),
    );
    expect(step).toMatchObject({ status: "degraded" });
    expect(step.status === "degraded" ? step.budgetMs : 0).toBeLessThanOrEqual(
      20,
    );
  });

  test("reports any other failure as failed, with its own error", async () => {
    const failure = new Error("court list unreadable");
    expect(
      await runBoundedRequestStep(async () => await Promise.reject(failure), {
        label: "court-list",
        budgetMs: 1000,
      }),
    ).toEqual({ status: "failed", error: failure });
  });
});
