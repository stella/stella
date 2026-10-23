type ErrorReporter = (error: unknown) => void;

let reportedErrors = new WeakSet<Error>();

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

export const resetReportedErrorsForTests = (): void => {
  reportedErrors = new WeakSet<Error>();
};
