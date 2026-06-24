// Passive regression fixture for `require-escape-like/require-escape-like`.
//
// Each `oxlint-disable-next-line` below intentionally suppresses a case the
// rule MUST flag. If the rule regresses, the matching disable becomes unused
// and `--report-unused-disable-directives-severity=error` fails CI. The allowed
// cases carry no disable, so a false positive would fail the fixture too.

declare const ilike: (column: unknown, pattern: string) => unknown;
declare const like: (column: unknown, pattern: string) => unknown;
declare const notIlike: (column: unknown, pattern: string) => unknown;
declare const escapeLike: (value: string) => string;
declare const column: unknown;
declare const q: string;

// MUST flag: inline un-escaped interpolation.
export const inlineUnescaped = () =>
  // oxlint-disable-next-line require-escape-like/require-escape-like
  ilike(column, `%${q}%`);

// MUST flag: a const pattern resolved to an un-escaped template literal.
const unsafePattern = `%${q}%`;
export const constUnescaped = () =>
  // oxlint-disable-next-line require-escape-like/require-escape-like
  like(column, unsafePattern);

// MUST flag: an un-escaped prefix interpolation.
export const prefixUnescaped = () =>
  // oxlint-disable-next-line require-escape-like/require-escape-like
  notIlike(column, `${q}%`);

// Allowed — every interpolation wrapped in escapeLike.
export const escapedInline = () => ilike(column, `%${escapeLike(q)}%`);
export const escapedPrefix = () => like(column, `${escapeLike(q)}%`);

// Allowed — constant pattern with no interpolation.
export const literalPattern = () => ilike(column, "literal");

// Allowed — opaque variable the rule cannot inspect.
declare const opaquePattern: string;
export const opaque = () => ilike(column, opaquePattern);
