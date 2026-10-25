import { Result } from "better-result";
import { AsyncLocalStorage } from "node:async_hooks";

import { classifyFailure } from "@stll/errors";

import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { withTimeout } from "@/api/lib/with-timeout";

/**
 * The latency budget of the request being served, carried through its work.
 *
 * A caller waits for the whole answer, so nothing a request waits on may
 * outwait the request itself: a dependency with a longer timeout turns one
 * slow dependency into a slow request that still answers, which no error
 * alarm sees. An MCP `tools/call` opens a scope with its tool's budget
 * (`mcp/tool-latency-budgets.ts`). Inside it:
 *
 * - shared clients clamp their own timeouts with `requestBoundedTimeoutMs`
 *   (the corpus index client, the public-law statement timeout), so the
 *   request fails fast at its budget instead of waiting theirs out;
 * - an optional step runs through `runBoundedRequestStep` with a named
 *   sub-budget, and answers a typed degraded outcome the caller reports
 *   instead of blocking.
 *
 * Outside a scope (background work, routes without a declared budget) both
 * leave the caller's own timeout as it is.
 */
type RequestLatencyScope = {
  readonly label: string;
  readonly budgetMs: number;
  /** `performance.now()` at which the budget runs out. */
  readonly deadlineAtMs: number;
};

const requestLatencyScope = new AsyncLocalStorage<RequestLatencyScope>();

export const runWithinRequestLatencyBudget = <T>(
  { label, budgetMs }: { label: string; budgetMs: number },
  fn: () => T,
): T =>
  requestLatencyScope.run(
    { label, budgetMs, deadlineAtMs: performance.now() + budgetMs },
    fn,
  );

/** What is left of the current request's budget; undefined outside a scope. */
export const remainingRequestBudgetMs = (): number | undefined => {
  const scope = requestLatencyScope.getStore();
  return scope === undefined
    ? undefined
    : Math.max(0, scope.deadlineAtMs - performance.now());
};

/**
 * `timeoutMs`, or what is left of the request's budget when that is shorter.
 *
 * Never below one millisecond: the timers this feeds read zero as "no
 * deadline", which is the opposite of a spent budget. A non-positive
 * `timeoutMs` (no deadline of its own) is bounded by the request alone.
 */
export const requestBoundedTimeoutMs = (timeoutMs: number): number => {
  const remaining = remainingRequestBudgetMs();
  if (remaining === undefined) {
    return timeoutMs;
  }
  const bounded = Math.max(1, Math.floor(remaining));
  return timeoutMs > 0 ? Math.min(timeoutMs, bounded) : bounded;
};

/**
 * How an optional request step ended.
 *
 * `degraded` means the step's sub-budget, or the request's own, ran out: the
 * caller answers without the step and says so. Its error is classified
 * `timeout_budgeted`, so observing it never grades as an unbounded timeout.
 */
export type BoundedRequestStep<T> =
  | { readonly status: "complete"; readonly value: T }
  | {
      readonly status: "degraded";
      readonly reason: "budget_exhausted";
      readonly budgetMs: number;
      readonly error: TimeoutError;
    }
  | { readonly status: "failed"; readonly error: unknown };

/**
 * Run an optional step under a named sub-budget of the request's budget.
 *
 * The step gets `budgetMs` or what is left of the request, whichever is
 * shorter; the census (`request-path-timeout-census.test.ts`) holds every
 * sub-budget under the budget of each tool that reaches it.
 */
export const runBoundedRequestStep = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  { label, budgetMs }: { label: string; budgetMs: number },
): Promise<BoundedRequestStep<T>> => {
  const timeoutMs = requestBoundedTimeoutMs(budgetMs);
  const outcome = await Result.tryPromise({
    try: async () => await withTimeout(operation, { label, timeoutMs }),
    catch: (cause) => cause,
  });
  if (Result.isOk(outcome)) {
    return { status: "complete", value: outcome.value };
  }
  const { error } = outcome;
  if (error instanceof TimeoutError && error.label === label) {
    return {
      status: "degraded",
      reason: "budget_exhausted",
      budgetMs: timeoutMs,
      error: classifyFailure(error, "timeout_budgeted"),
    };
  }
  return { status: "failed", error };
};
