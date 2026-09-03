// Passive regression fixture for
// `no-try-catch-outside-boundary/no-try-catch-outside-boundary`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the corresponding disable becomes
// unused and `--report-unused-disable-directives-severity=error` fails CI.

import { Result } from "better-result";

declare const riskyCall: () => Promise<string>;
declare const cleanup: () => void;
declare const parseInput: (input: string) => unknown;
declare const mapError: (error: unknown) => Error;

// Flagged: `try` with a `catch` clause.
const _tryCatch = async (): Promise<string | undefined> => {
  // oxlint-disable-next-line no-try-catch-outside-boundary/no-try-catch-outside-boundary -- fixture: try/catch outside a boundary module
  try {
    return await riskyCall();
  } catch {
    return undefined;
  }
};

// Flagged: a literal try/catch nested inside the arrow passed as the `try`
// callback of `Result.tryPromise`. The rule flags the AST shape, not the
// surrounding call, so hiding a catch inside that callback still counts.
const _nestedTryInsideTryPromise = async () =>
  await Result.tryPromise({
    try: async () => {
      // oxlint-disable-next-line no-try-catch-outside-boundary/no-try-catch-outside-boundary -- fixture: literal try/catch nested inside a Result.tryPromise callback
      try {
        return await riskyCall();
      } catch (error) {
        return mapError(error);
      }
    },
    catch: (error) => mapError(error),
  });

// --- Cases the rule MUST NOT flag ---

// Allowed: `try/finally` without a `catch` clause.
const _tryFinally = async (): Promise<string> => {
  try {
    return await riskyCall();
  } finally {
    cleanup();
  }
};

// Allowed: `Result.tryPromise({ try, catch })` — object keys named `try`
// and `catch` must not trip a naive text/property matcher.
const _resultTryPromise = async () =>
  await Result.tryPromise({
    try: async () => await riskyCall(),
    catch: (error) => mapError(error),
  });

// Allowed: `Result.try(...)` for a synchronous failable call.
const _resultTry = (input: string) => Result.try(() => parseInput(input));

export const __noTryCatchOutsideBoundaryFixture = {
  _tryCatch,
  _nestedTryInsideTryPromise,
  _tryFinally,
  _resultTryPromise,
  _resultTry,
};
