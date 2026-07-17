// Passive regression fixture for
// `require-function-replacer/require-function-replacer`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The
// allowed cases carry no disable, so a false positive would fail the
// fixture too.

declare const text: string;
declare const dynamicValue: string;
declare const pattern: string;
declare const getReplacement: () => string;
declare const flag: boolean;
declare function importedReplacer(match: string): string;

// MUST flag: bare identifier bound to a dynamic (non-function) value.
export const identifierValue = () =>
  // oxlint-disable-next-line require-function-replacer/require-function-replacer
  text.replace(pattern, dynamicValue);

// MUST flag: template literal WITH interpolation — `$` sequences inside
// `dynamicValue` would still be pattern-substituted.
export const templateWithInterpolation = () =>
  // oxlint-disable-next-line require-function-replacer/require-function-replacer
  text.replace(pattern, `prefix-${dynamicValue}`);

// MUST flag: call expression result used directly.
export const callExpressionValue = () =>
  // oxlint-disable-next-line require-function-replacer/require-function-replacer
  text.replace(pattern, getReplacement());

// MUST flag: member expression used directly.
export const memberExpressionValue = () => {
  const holder = { field: dynamicValue };
  // oxlint-disable-next-line require-function-replacer/require-function-replacer
  return text.replace(pattern, holder.field);
};

// MUST flag: conditional expression.
export const conditionalValue = () =>
  // oxlint-disable-next-line require-function-replacer/require-function-replacer
  text.replace(pattern, flag ? dynamicValue : "fallback");

// MUST flag: same analysis applies to replaceAll.
export const replaceAllIdentifierValue = () =>
  // oxlint-disable-next-line require-function-replacer/require-function-replacer
  text.replaceAll(pattern, dynamicValue);

// MUST flag: identifier resolves to a function PARAMETER, not a
// declaration/arrow-assignment — the rule only trusts the two syntactic
// forms it documents, so a parameter (even if callers only ever pass
// functions) is reported.
export const parameterBoundReplacer = (replacer: (match: string) => string) =>
  // oxlint-disable-next-line require-function-replacer/require-function-replacer
  text.replace(pattern, replacer);

// MUST flag: identifier resolves to an IMPORTED function — the rule does
// not trust import bindings, only local declarations/arrow assignments.
export const importedFunctionReplacer = () =>
  // oxlint-disable-next-line require-function-replacer/require-function-replacer
  text.replace(pattern, importedReplacer);

// MUST flag: `let` re-assigned away from its function initializer is still
// allowed by this purely syntactic rule (documented limitation) is NOT what
// this case tests — this one is a `let` whose initializer is itself
// non-function, which must always be flagged.
export const letBoundToDynamicValue = () => {
  let label = dynamicValue;
  label = `${label}!`;
  // oxlint-disable-next-line require-function-replacer/require-function-replacer
  return text.replace(pattern, label);
};

// Allowed — inline arrow function replacer.
export const arrowReplacer = () => text.replace(pattern, () => dynamicValue);

// Allowed — inline function-expression replacer.
export const functionExpressionReplacer = () =>
  text.replace(pattern, (match) => match.toUpperCase());

// Allowed — string literal replacement (author-visible `$` usage, if any,
// is intentional).
export const stringLiteralReplacer = () => text.replace(pattern, "literal");

// Allowed — no-substitution template literal, same reasoning as a string
// literal.
export const templateLiteralReplacer = () => text.replace(pattern, `literal`);

// Allowed — identifier resolving to a local function declaration.
export const functionDeclarationReplacer = () => {
  function toReplacement(match: string) {
    return match;
  }
  return text.replace(pattern, toReplacement);
};

// Allowed — identifier resolving to a local `const` arrow-function
// assignment.
export const constArrowReplacer = () => {
  const toReplacement = (match: string) => match;
  return text.replace(pattern, toReplacement);
};

// Allowed — identifier resolving to a local `const` function-expression
// assignment.
export const constFunctionExpressionReplacer = () => {
  const toReplacement = (match: string) => match;
  return text.replaceAll(pattern, toReplacement);
};

// Allowed — single-argument call is not checked at all (not a
// pattern+replacement pair).
export const singleArgumentCall = () => text.replace(pattern);

// Allowed — spread call is not checked (not a syntactically-visible
// two-argument pair).
export const spreadArgumentsCall = (args: [string, string]) =>
  text.replace(...args);

// Allowed — an object-expression second argument means this is not
// `String.prototype.replace` at all (e.g. Bun's `HTMLRewriter`
// `Element.replace(content, { html })`), so it is skipped rather than
// required to be a function.
declare const htmlRewriterElement: {
  replace: (content: string, options?: { html?: boolean }) => unknown;
};
export const nonStringReplaceWithOptionsObject = () =>
  htmlRewriterElement.replace(dynamicValue, { html: true });
