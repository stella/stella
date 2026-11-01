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
 * - shared clients clamp their own timeouts with `requestBoundedTimeout`
 *   (the corpus index client, the public-law transaction deadline), so the
 *   request fails fast at its budget instead of waiting theirs out, and
 *   report that failure as the budget's (`requestBudgetExpiry`), which every
 *   surface answers as a timeout rather than as the dependency failing;
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

/**
 * Open a request latency scope. `startedAtMs` is the `performance.now()` at
 * which the request began, so time spent before the scope opens (auth,
 * context, server build) is charged to the budget the request is judged by;
 * omitted, the budget starts now.
 */
export const runWithinRequestLatencyBudget = <T>(
  {
    label,
    budgetMs,
    startedAtMs = performance.now(),
  }: { label: string; budgetMs: number; startedAtMs?: number | undefined },
  fn: () => T,
): T =>
  requestLatencyScope.run(
    { label, budgetMs, deadlineAtMs: startedAtMs + budgetMs },
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
 * How far below the request's deadline a timeout may end and still be the
 * request's: the clamp floors to whole milliseconds, so a clamped timer fires
 * up to a millisecond early.
 */
const REQUEST_DEADLINE_FLOOR_MS = 1;

/**
 * A timeout bounded by the request's budget, and whether the deadline it keeps
 * is the request's own. Only then is its expiry the budget's
 * (`requestBudgetExpiry`); a shorter timeout of the dependency's own that
 * fires while the request still has time is the dependency's failure.
 */
export type RequestBoundedTimeout = {
  readonly timeoutMs: number;
  readonly endsAtRequestDeadline: boolean;
};

/**
 * `timeoutMs`, or what is left of the request's budget when that is shorter.
 *
 * Never below one millisecond: the timers this feeds read zero as "no
 * deadline", which is the opposite of a spent budget. A non-positive
 * `timeoutMs` (no deadline of its own) is bounded by the request alone.
 */
export const requestBoundedTimeout = (
  timeoutMs: number,
): RequestBoundedTimeout => {
  const remaining = remainingRequestBudgetMs();
  if (remaining === undefined) {
    return { timeoutMs, endsAtRequestDeadline: false };
  }
  const bounded = Math.max(1, Math.floor(remaining));
  return timeoutMs > 0 && timeoutMs < remaining - REQUEST_DEADLINE_FLOOR_MS
    ? { timeoutMs, endsAtRequestDeadline: false }
    : {
        timeoutMs: timeoutMs > 0 ? Math.min(timeoutMs, bounded) : bounded,
        endsAtRequestDeadline: true,
      };
};

/** `requestBoundedTimeout` for a caller that never attributes the expiry. */
export const requestBoundedTimeoutMs = (timeoutMs: number): number =>
  requestBoundedTimeout(timeoutMs).timeoutMs;

/** Every failure `requestBudgetExpiry` attributed to a request's budget. */
const budgetExpiries = new WeakSet<TimeoutError>();

/** How deep `findRequestBudgetExpiry` follows a chain of causes. */
const MAX_BUDGET_EXPIRY_CAUSE_DEPTH = 8;

/**
 * The request budget expiry a failure carries, through the wrappers and causes
 * it reached the caller in, or undefined when the budget did not end it.
 */
export const findRequestBudgetExpiry = (
  error: unknown,
): TimeoutError | undefined => {
  const visited = new Set<unknown>();
  let current = error;
  for (
    let depth = 0;
    depth <= MAX_BUDGET_EXPIRY_CAUSE_DEPTH &&
    current instanceof Error &&
    !visited.has(current);
    depth++
  ) {
    if (current instanceof TimeoutError && budgetExpiries.has(current)) {
      return current;
    }
    visited.add(current);
    current = current.cause;
  }
  return undefined;
};

/**
 * A failure the request's budget caused, as the budget's own `TimeoutError`
 * (classified `timeout_budgeted`, the original failure as its cause), or
 * undefined outside a scope and for any other failure.
 *
 * A dependency the request clamped to its deadline fails in its own terms (a
 * cancelled statement, a session the server ended). Only the caller knows
 * whether the timeout that fired was the one the request's budget shortened
 * (`clampedTimeout`, recorded when it installed the timeout), so only then is
 * the failure the budget's, even a hair before the deadline (the clamp floors
 * to whole milliseconds). Any other failure, a timeout of its own or an
 * explicit cancel among them, keeps its own grade.
 */
export const requestBudgetExpiry = (
  cause: unknown,
  { clampedTimeout }: { clampedTimeout: boolean },
): TimeoutError | undefined => {
  const scope = requestLatencyScope.getStore();
  if (scope === undefined || !clampedTimeout) {
    return undefined;
  }
  const expiry = classifyFailure(
    new TimeoutError({
      message: `${scope.label} exceeded its ${String(scope.budgetMs)}ms latency budget`,
      label: scope.label,
      timeoutMs: scope.budgetMs,
      cause,
    }),
    "timeout_budgeted",
  );
  budgetExpiries.add(expiry);
  return expiry;
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
