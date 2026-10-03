import { panic } from "better-result";

/**
 * An ingestion cycle's time budget: when it runs out, and the signal that
 * fires then. The signal is derived from the same budget, so a loop cannot
 * hold a deadline that disagrees with the abort its work will actually get.
 */
export type CycleDeadline = {
  /** Monotonic clock reading (`performance.now()`) at which the budget ends. */
  readonly expiresAt: number;
  /** Aborts at `expiresAt`, or earlier when one of the outer signals fires. */
  readonly signal: AbortSignal;
};

export type StartCycleDeadlineOptions = {
  budgetMs: number;
  /** Outer signals that end the cycle early, such as a worker drain. */
  abortEarlyOn?: readonly AbortSignal[];
};

export const startCycleDeadline = ({
  budgetMs,
  abortEarlyOn = [],
}: StartCycleDeadlineOptions): CycleDeadline => {
  const budget = AbortSignal.timeout(budgetMs);
  return {
    expiresAt: performance.now() + budgetMs,
    signal:
      abortEarlyOn.length === 0
        ? budget
        : AbortSignal.any([budget, ...abortEarlyOn]),
  };
};

let cycleReservations: WeakMap<CycleDeadline, number> | undefined;

/** Milliseconds left after committed reservations; negative once exhausted. */
export const remainingCycleMs = (deadline: CycleDeadline): number =>
  deadline.expiresAt -
  performance.now() -
  (cycleReservations?.get(deadline) ?? 0);

/**
 * Whether a page costing up to `pageBudgetMs` can still finish inside the
 * cycle. A page started past that point is aborted mid-flight at the cycle
 * deadline: its work is discarded and the cycle ends as an adapter failure
 * rather than a timeout, so the loop stops on the last completed page
 * instead of starting it.
 */
export const canStartCyclePage = (
  deadline: CycleDeadline,
  pageBudgetMs: number,
): boolean =>
  !deadline.signal.aborted && remainingCycleMs(deadline) >= pageBudgetMs;

/** Charge bounded housekeeping before work; reservations last for the cycle. */
export const reserveCycleBudget = (
  deadline: CycleDeadline,
  costMs: number,
): boolean => {
  if (!Number.isFinite(costMs) || costMs <= 0) {
    panic("Cycle reservation must be finite and positive");
  }
  if (!canStartCyclePage(deadline, costMs)) {
    return false;
  }
  cycleReservations ??= new WeakMap();
  cycleReservations.set(
    deadline,
    (cycleReservations.get(deadline) ?? 0) + costMs,
  );
  return true;
};
