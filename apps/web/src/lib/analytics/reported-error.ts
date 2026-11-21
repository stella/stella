type ErrorReporter = (error: unknown) => void;

let reportedErrors = new WeakSet<Error>();
let boundaryOwnedErrors = new WeakSet<Error>();

/** Claim an Error object before sending it to telemetry. */
export const reportErrorOnce = (
  error: unknown,
  report: ErrorReporter,
): boolean => {
  if (error instanceof Error) {
    if (reportedErrors.has(error)) {
      return false;
    }
    reportedErrors.add(error);
  }
  report(error);
  return true;
};

/**
 * The boundary that caught this error decides whether and how it is reported:
 * with its support reference, once its retries run out, or not at all.
 */
export const leaveErrorToBoundary = (error: unknown): void => {
  if (error instanceof Error) {
    boundaryOwnedErrors.add(error);
  }
};

/**
 * Report a caught error unless a boundary took it. React calls the root's
 * `onCaughtError` first and the boundary's `componentDidCatch` later in the
 * same commit, so the decision waits until that commit has finished.
 */
export const reportUnownedCaughtError = (
  error: unknown,
  report: ErrorReporter,
): void => {
  queueMicrotask(() => {
    if (error instanceof Error && boundaryOwnedErrors.has(error)) {
      return;
    }
    reportErrorOnce(error, report);
  });
};

export const resetReportedErrorsForTests = (): void => {
  reportedErrors = new WeakSet<Error>();
  boundaryOwnedErrors = new WeakSet<Error>();
};
