/* oxlint-disable unicorn/new-for-builtins */
// Passive regression fixture for `no-bare-error/no-bare-error`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag; unused-disable reporting fails CI if the rule regresses.
// Each `expect-clean` marker names a case the rule must accept. The unicorn
// override at the top silences the stylistic "use new with Error" rule that
// would otherwise crowd the regression signal.

import * as betterResult from "better-result";
import { Err, Result, Result as Outcome } from "better-result";

declare class FixtureError extends Error {
  constructor(message: string);
}

const ERROR_MESSAGE = "regression fixture: never thrown at runtime";

// --- flagged: thrown ---

const _newForm = (): never => {
  // oxlint-disable-next-line no-bare-error/no-bare-error
  throw new Error(ERROR_MESSAGE);
};

const _bareForm = (): never => {
  throw Error(ERROR_MESSAGE); // oxlint-disable-line no-bare-error/no-bare-error
};

const _globalThisNew = (): never => {
  // oxlint-disable-next-line no-bare-error/no-bare-error
  throw new globalThis.Error(ERROR_MESSAGE);
};

const _globalThisCall = (): never => {
  // oxlint-disable-next-line no-bare-error/no-bare-error
  throw globalThis.Error(ERROR_MESSAGE);
};

const _globalThisComputed = (): never => {
  // oxlint-disable-next-line no-bare-error/no-bare-error, typescript/dot-notation -- computed member fixture
  throw new globalThis["Error"](ERROR_MESSAGE);
};

const _typeErrorNew = (): never => {
  // oxlint-disable-next-line no-bare-error/no-bare-error
  throw new TypeError(ERROR_MESSAGE);
};

const _typeErrorCall = (): never => {
  // oxlint-disable-next-line no-bare-error/no-bare-error
  throw TypeError(ERROR_MESSAGE);
};

const _rangeErrorNew = (): never => {
  // oxlint-disable-next-line no-bare-error/no-bare-error
  throw new RangeError(ERROR_MESSAGE);
};

const _rangeErrorCall = (): never => {
  // oxlint-disable-next-line no-bare-error/no-bare-error
  throw RangeError(ERROR_MESSAGE);
};

const _assertedThrow = (): never => {
  // oxlint-disable-next-line no-bare-error/no-bare-error, typescript/no-unnecessary-type-assertion -- type assertion fixture
  throw new Error(ERROR_MESSAGE) as Error;
};

// --- flagged: wrapped in a Result ---

// oxlint-disable-next-line no-bare-error/no-bare-error
const _resultErr = () => Result.err(new Error(ERROR_MESSAGE));

// oxlint-disable-next-line no-bare-error/no-bare-error
const _resultErrCall = () => Result.err(TypeError(ERROR_MESSAGE));

// Aliased import of Result.
// oxlint-disable-next-line no-bare-error/no-bare-error
const _aliasedResult = () => Outcome.err(new RangeError(ERROR_MESSAGE));

// Namespace import of Result.
const _namespaceResult = () =>
  // oxlint-disable-next-line no-bare-error/no-bare-error
  betterResult.Result.err(new Error(ERROR_MESSAGE));

// The Err constructor.
// oxlint-disable-next-line no-bare-error/no-bare-error
const _errConstructor = () => new Err(new globalThis.Error(ERROR_MESSAGE));

// --- accepted ---

const _taggedThrow = (): never => {
  // expect-clean: no-bare-error/no-bare-error
  throw new FixtureError(ERROR_MESSAGE);
};

// expect-clean: no-bare-error/no-bare-error
const _taggedResult = () => Result.err(new FixtureError(ERROR_MESSAGE));

// A local namesake of Result is not better-result's.
const _localResult = () => {
  // oxlint-disable-next-line no-shadow -- the local namesake is the case under test
  const Result = { err: (error: Error) => error };
  // expect-clean: no-bare-error/no-bare-error
  return Result.err(new Error(ERROR_MESSAGE));
};

// A local class shadowing the global name is not the native error.
const _shadowedError = (): never => {
  const Error = FixtureError;
  // expect-clean: no-bare-error/no-bare-error
  throw new Error(ERROR_MESSAGE);
};

export const __noBareErrorFixture = {
  _newForm,
  _bareForm,
  _globalThisNew,
  _globalThisCall,
  _globalThisComputed,
  _typeErrorNew,
  _typeErrorCall,
  _rangeErrorNew,
  _rangeErrorCall,
  _assertedThrow,
  _resultErr,
  _resultErrCall,
  _aliasedResult,
  _namespaceResult,
  _errConstructor,
  _taggedThrow,
  _taggedResult,
  _localResult,
  _shadowedError,
};
