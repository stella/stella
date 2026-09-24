// Passive regression fixture for `result-boundary/no-throw-outside-boundary`
// and `result-boundary/no-try-catch-outside-boundary`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the corresponding disable becomes
// unused and `--report-unused-disable-directives-severity=error` fails CI.
// Each `expect-clean` marker names a case the rule must accept.

import { Result, panic, panic as invariantFailure } from "better-result";

declare class SomeTaggedError extends Error {
  constructor(message: string);
}
declare const toAPIError: (error: unknown) => Error;
declare const redirect: (target: string) => Error;
declare const recordRetryAttempt: () => void;
declare const cause: unknown;
declare const standaloneError: SomeTaggedError;
declare const riskyCall: () => Promise<string>;
declare const cleanup: () => void;
declare const parseInput: (input: string) => unknown;
declare const mapError: (error: unknown) => Error;

// --- no-throw-outside-boundary: flagged ---

// A newly constructed tagged error.
const _throwsNewTaggedError = (): never => {
  // oxlint-disable-next-line result-boundary/no-throw-outside-boundary -- fixture: throwing a new tagged error instead of returning Result.err
  throw new SomeTaggedError("boundary violation");
};

// The result of a factory or coercion call.
const _throwsFactoryError = (): never => {
  // oxlint-disable-next-line result-boundary/no-throw-outside-boundary -- fixture: throwing a factory-produced error instead of returning Result.err
  throw toAPIError(cause);
};

// A framework helper call (a router redirect).
const _throwsRedirect = (): never => {
  // oxlint-disable-next-line result-boundary/no-throw-outside-boundary -- fixture: throwing a framework helper call outside a boundary module
  throw redirect("/login");
};

// An identifier throw outside any catch is not a re-throw.
const _throwsStandaloneIdentifier = (): never => {
  // oxlint-disable-next-line result-boundary/no-throw-outside-boundary -- fixture: throwing an identifier outside a catch is not a re-throw
  throw standaloneError;
};

// A catch block that throws a new error (wrapping) is not a re-throw.
const _wrapsCaughtError = (): never => {
  // oxlint-disable-next-line result-boundary/no-try-catch-outside-boundary -- fixture: the enclosing try/catch is itself outside a boundary module
  try {
    return _throwsNewTaggedError();
  } catch (error) {
    // oxlint-disable-next-line result-boundary/no-throw-outside-boundary -- fixture: wrapping the caught error in a new throw is not a re-throw
    throw new SomeTaggedError(`wrapped: ${String(error)}`);
  }
};

// A closure captures the catch binding; its later throw is not the
// synchronous re-throw the exception permits.
const _throwsCatchBindingFromClosure = (): never => {
  // oxlint-disable-next-line result-boundary/no-try-catch-outside-boundary -- fixture: the enclosing try/catch is itself outside a boundary module
  try {
    return _throwsNewTaggedError();
  } catch (error) {
    const throwLater = (): never => {
      // oxlint-disable-next-line result-boundary/no-throw-outside-boundary -- fixture: a closure throw is not a synchronous catch re-throw
      throw error;
    };
    return throwLater();
  }
};

// The nested block's binding shadows the catch parameter.
const _throwsShadowedCatchBinding = (): never => {
  // oxlint-disable-next-line result-boundary/no-try-catch-outside-boundary -- fixture: the enclosing try/catch is itself outside a boundary module
  try {
    return _throwsNewTaggedError();
  } catch (error) {
    recordRetryAttempt();
    void error;
    {
      // oxlint-disable-next-line no-shadow -- fixture: shadowing proves the thrown binding is resolved by scope rather than spelling
      const error = standaloneError;
      // oxlint-disable-next-line result-boundary/no-throw-outside-boundary -- fixture: a shadowing local is not the catch binding
      throw error;
    }
  }
};

// A local function merely named `panic` is not better-result's panic.
const _throwsLocalPanicNamesake = (): never => {
  // oxlint-disable-next-line no-shadow -- fixture: the local namesake is the case under test
  const panic = (message: string): Error => new SomeTaggedError(message);
  // oxlint-disable-next-line result-boundary/no-throw-outside-boundary -- fixture: a local namesake of panic is not the better-result helper
  throw panic("not the better-result helper");
};

// --- no-throw-outside-boundary: accepted ---

// Re-throwing the exact identifier bound by the enclosing catch.
const _rethrowsCatchBinding = (): never => {
  // oxlint-disable-next-line result-boundary/no-try-catch-outside-boundary -- fixture: the enclosing try/catch is itself outside a boundary module
  try {
    return _throwsNewTaggedError();
  } catch (error) {
    recordRetryAttempt();
    // expect-clean: result-boundary/no-throw-outside-boundary
    throw error;
  }
};

// `panic()` used as a statement for an impossible state.
const _panicsOnImpossibleState = (flag: boolean): void => {
  if (!flag) {
    panic("impossible state reached");
  }
};

// `panic()` returned directly from a function typed `never`.
const _returnsPanic = (flag: boolean): never =>
  flag ? panic("impossible state reached") : panic("unreachable");

// Defensive `throw panic(...)`: panic() never returns, so the wrapper is inert.
const _throwsPanicDefensively = (): never => {
  // expect-clean: result-boundary/no-throw-outside-boundary
  throw panic("defensive throw wrapper"); // oxlint-disable-line typescript/only-throw-error -- fixture: panic() returns `never`, which the built-in rule does not recognize as an Error-compatible throw
};

// Aliased import of panic.
const _throwsAliasedPanic = (): never => {
  // expect-clean: result-boundary/no-throw-outside-boundary
  throw invariantFailure("aliased import"); // oxlint-disable-line typescript/only-throw-error -- fixture: panic() returns `never`, which the built-in rule does not recognize as an Error-compatible throw
};

// --- no-try-catch-outside-boundary: flagged ---

// `try` with a `catch` clause.
const _tryCatch = async (): Promise<string | undefined> => {
  // oxlint-disable-next-line result-boundary/no-try-catch-outside-boundary -- fixture: try/catch outside a boundary module
  try {
    return await riskyCall();
  } catch {
    return undefined;
  }
};

// A literal try/catch nested inside the `try` callback of `Result.tryPromise`:
// the rule flags the AST shape, not the surrounding call.
const _nestedTryInsideTryPromise = async () =>
  await Result.tryPromise({
    try: async () => {
      // oxlint-disable-next-line result-boundary/no-try-catch-outside-boundary -- fixture: literal try/catch nested inside a Result.tryPromise callback
      try {
        return await riskyCall();
      } catch (error) {
        return mapError(error);
      }
    },
    catch: (error) => mapError(error),
  });

// --- no-try-catch-outside-boundary: accepted ---

// `try/finally` without a `catch` clause.
const _tryFinally = async (): Promise<string> => {
  // expect-clean: result-boundary/no-try-catch-outside-boundary
  try {
    return await riskyCall();
  } finally {
    cleanup();
  }
};

// `Result.tryPromise({ try, catch })`: object keys named `try` and `catch`
// must not trip a text or property matcher.
const _resultTryPromise = async () =>
  // expect-clean: result-boundary/no-try-catch-outside-boundary
  await Result.tryPromise({
    try: async () => await riskyCall(),
    catch: (error) => mapError(error),
  });

// `Result.try(...)` for a synchronous failable call.
const _resultTry = (input: string) =>
  // expect-clean: result-boundary/no-try-catch-outside-boundary
  Result.try(() => parseInput(input));

export const __resultBoundaryFixture = {
  _throwsNewTaggedError,
  _throwsFactoryError,
  _throwsRedirect,
  _throwsStandaloneIdentifier,
  _wrapsCaughtError,
  _throwsCatchBindingFromClosure,
  _throwsShadowedCatchBinding,
  _throwsLocalPanicNamesake,
  _rethrowsCatchBinding,
  _panicsOnImpossibleState,
  _returnsPanic,
  _throwsPanicDefensively,
  _throwsAliasedPanic,
  _tryCatch,
  _nestedTryInsideTryPromise,
  _tryFinally,
  _resultTryPromise,
  _resultTry,
};
