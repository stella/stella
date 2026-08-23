/**
 * Renders the detail argument of the runner's plain-text error lines.
 *
 * Split out of the daemon so the error shapes below are testable: how an
 * error renders is the whole value of an error log.
 */

/**
 * An error's own description, preferring its stack.
 *
 * Emptiness rather than absence is what "carries no stack" looks like
 * here: Bun rejects a timed-out `fetch` with a `DOMException` whose
 * `stack` is the empty string, so a nullish fallback keeps that empty
 * string and renders the error as nothing at all. Falling back to
 * `name: message` also matches the first line of a stack, so both
 * branches read the same.
 */
const UNSERIALIZABLE = "[unserializable log detail]";

/**
 * `JSON.stringify` is declared to return `string`, but returns undefined
 * for a function, a symbol, or a value whose `toJSON` yields one. Stating
 * the real signature keeps the fallback below visible to the type checker
 * rather than looking redundant to it.
 */
const serialize = (value: unknown): string | undefined => JSON.stringify(value);

const describeError = (error: Error): string => {
  const { stack } = error;
  return stack !== undefined && stack.length > 0
    ? stack
    : `${error.name}: ${error.message}`;
};

export const formatLogDetail = (detail: unknown): string => {
  if (detail === undefined) {
    return "";
  }

  if (detail instanceof Error) {
    const base = describeError(detail);
    // Wrapped driver errors (e.g. DrizzleQueryError) carry the actual
    // failure in `cause`; without it the log shows only the query text.
    return detail.cause instanceof Error
      ? `${base}\n[cause] ${describeError(detail.cause)}`
      : base;
  }

  if (typeof detail === "string") {
    return detail;
  }

  // Two ways to be unserialisable and only one of them throws: a cyclic
  // value raises, a function or symbol returns undefined.
  try {
    return serialize(detail) ?? UNSERIALIZABLE;
  } catch {
    return UNSERIALIZABLE;
  }
};
