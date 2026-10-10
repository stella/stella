const CHILD_EXIT_FAILURE = 1;
const MAX_CHILD_EXIT_STATUS = 255;

type ChildTermination = {
  readonly signalCode?: string | number | null;
  readonly signal?: string | number | null;
  readonly error?: unknown;
};

type ChildExitResult =
  | (ChildTermination & { readonly exitCode: number | null | undefined })
  | (ChildTermination & { readonly status: number | null });

/** Normalize a completed child before its termination metadata is discarded. */
export const childExitStatus = (
  result: ChildExitResult | number | null | undefined,
): number => {
  if (result === null || result === undefined) {
    return CHILD_EXIT_FAILURE;
  }
  if (typeof result === "number") {
    return Number.isInteger(result) &&
      result >= 0 &&
      result <= MAX_CHILD_EXIT_STATUS
      ? result
      : CHILD_EXIT_FAILURE;
  }
  if (
    (result.signalCode !== undefined && result.signalCode !== null) ||
    (result.signal !== undefined && result.signal !== null) ||
    (result.error !== undefined && result.error !== null)
  ) {
    return CHILD_EXIT_FAILURE;
  }
  const code = "exitCode" in result ? result.exitCode : result.status;
  return childExitStatus(code);
};
