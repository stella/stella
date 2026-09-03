// Passive regression fixture for
// `no-throw-outside-boundary/no-throw-outside-boundary`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the corresponding disable becomes
// unused and `--report-unused-disable-directives-severity=error` fails CI.

import { panic } from "better-result";

declare class SomeTaggedError extends Error {
  constructor(message: string);
}
declare const toAPIError: (error: unknown) => Error;
declare const redirect: (target: string) => Error;
declare const recordRetryAttempt: () => void;
declare const cause: unknown;
declare const standaloneError: SomeTaggedError;

// Flagged: throwing a newly constructed tagged error.
const _throwsNewTaggedError = (): never => {
  // oxlint-disable-next-line no-throw-outside-boundary/no-throw-outside-boundary -- fixture: throwing a new tagged error instead of returning Result.err
  throw new SomeTaggedError("boundary violation");
};

// Flagged: throwing the result of a factory/coercion call.
const _throwsFactoryError = (): never => {
  // oxlint-disable-next-line no-throw-outside-boundary/no-throw-outside-boundary -- fixture: throwing a factory-produced error instead of returning Result.err
  throw toAPIError(cause);
};

// Flagged: throwing a framework helper call (e.g. a router redirect).
const _throwsRedirect = (): never => {
  // oxlint-disable-next-line no-throw-outside-boundary/no-throw-outside-boundary -- fixture: throwing a framework helper call outside a boundary module
  throw redirect("/login");
};

// Flagged: an identifier throw outside any catch is not a re-throw.
const _throwsStandaloneIdentifier = (): never => {
  // oxlint-disable-next-line no-throw-outside-boundary/no-throw-outside-boundary -- fixture: throwing an identifier outside a catch is not a re-throw
  throw standaloneError;
};

// Flagged: a catch block that throws a NEW error (wrapping), not a
// re-throw of the caught binding.
const _wrapsCaughtError = (): never => {
  try {
    return _throwsNewTaggedError();
  } catch (error) {
    // oxlint-disable-next-line no-throw-outside-boundary/no-throw-outside-boundary -- fixture: wrapping the caught error in a new throw is not a re-throw
    throw new SomeTaggedError(`wrapped: ${String(error)}`);
  }
};

// Flagged: a closure captures the catch binding, but its later throw is not
// the synchronous re-throw this narrow exception permits.
const _throwsCatchBindingFromClosure = (): never => {
  try {
    return _throwsNewTaggedError();
  } catch (error) {
    const throwLater = (): never => {
      // oxlint-disable-next-line no-throw-outside-boundary/no-throw-outside-boundary -- fixture: a closure throw is not a synchronous catch re-throw
      throw error;
    };
    return throwLater();
  }
};

// Flagged: the nested block's binding shadows the catch parameter.
const _throwsShadowedCatchBinding = (): never => {
  try {
    return _throwsNewTaggedError();
  } catch (error) {
    recordRetryAttempt();
    void error;
    {
      // oxlint-disable-next-line no-shadow -- fixture: shadowing proves the thrown binding is resolved by scope rather than spelling
      const error = standaloneError;
      // oxlint-disable-next-line no-throw-outside-boundary/no-throw-outside-boundary -- fixture: a shadowing local is not the catch binding
      throw error;
    }
  }
};

// --- Cases the rule MUST NOT flag ---

// Allowed: re-throwing the exact identifier bound by the enclosing catch.
const _rethrowsCatchBinding = (): never => {
  try {
    return _throwsNewTaggedError();
  } catch (error) {
    recordRetryAttempt();
    throw error;
  }
};

// Allowed: `panic()` used as a statement for an impossible state.
const _panicsOnImpossibleState = (flag: boolean): void => {
  if (!flag) {
    panic("impossible state reached");
  }
};

// Allowed: `panic()` returned directly from a function typed `never`.
const _returnsPanic = (flag: boolean): never =>
  flag ? panic("impossible state reached") : panic("unreachable");

// Allowed defensively: `throw panic(...)`. `panic()` already never returns,
// but the rule does not flag the throw wrapper itself.
const _throwsPanicDefensively = (): never => {
  // oxlint-disable-next-line typescript/only-throw-error -- fixture: panic() returns `never`, which the built-in rule does not recognize as an Error-compatible throw
  throw panic("defensive throw wrapper");
};

export const __noThrowOutsideBoundaryFixture = {
  _throwsNewTaggedError,
  _throwsFactoryError,
  _throwsRedirect,
  _throwsStandaloneIdentifier,
  _wrapsCaughtError,
  _throwsCatchBindingFromClosure,
  _throwsShadowedCatchBinding,
  _rethrowsCatchBinding,
  _panicsOnImpossibleState,
  _returnsPanic,
  _throwsPanicDefensively,
};
