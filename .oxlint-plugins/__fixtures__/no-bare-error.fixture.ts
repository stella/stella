/* oxlint-disable unicorn/throw-new-error, unicorn/new-for-builtins */
// Passive regression fixture for `no-bare-error/no-bare-error`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a
// case the rule MUST flag. If the rule regresses (e.g. someone
// reverts the `Error()` CallExpression branch and only `new Error()`
// is flagged), the corresponding disable becomes unused and
// `--report-unused-disable-directives-severity=error` fails CI.
//
// The unicorn override at the top of the file silences the stylistic
// "use new with Error" rule that would otherwise crowd the actual
// regression signal.

const ERROR_MESSAGE = "regression fixture — never thrown at runtime";

const _newForm = (): never => {
  // oxlint-disable-next-line no-bare-error/no-bare-error
  throw new Error(ERROR_MESSAGE);
};

const _bareForm = (): never => {
  // oxlint-disable-next-line no-bare-error/no-bare-error
  throw Error(ERROR_MESSAGE);
};

// Reference the helpers so unused-variable rules don't kick in.
export const __noBareErrorFixture = { _newForm, _bareForm };
