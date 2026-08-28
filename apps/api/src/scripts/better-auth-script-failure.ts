/**
 * One stderr line per Better Auth script failure. The scripts run where this
 * line is the only diagnostic channel, so it carries the tagged code, the
 * script's own message, and a fixed-vocabulary description of the cause.
 * Free-text error messages never reach the output: query wrappers embed bound
 * parameters and Postgres embeds offending values, either of which could be
 * identity data. Names, error codes, and SQLSTATEs are drawn from closed
 * vocabularies and are safe to print.
 */

const MAX_CAUSE_DEPTH = 5;
const FIXED_VOCABULARY_CODE = /^[A-Z][A-Z0-9_]{1,63}$/u;
const SQLSTATE = /^[0-9A-Z]{5}$/u;

type BetterAuthScriptFailure = {
  cause?: unknown;
  code: string;
  message: string;
};

type BetterAuthScriptFailureCause = {
  code?: string;
  names: string[];
  sqlState?: string;
};

const readToken = (error: Error, key: string, pattern: RegExp) => {
  const value = Reflect.get(error, key);
  return typeof value === "string" && pattern.test(value) ? value : undefined;
};

// Walks the cause chain from the outermost error inward; the innermost
// error's code and SQLSTATE win because wrappers repeat or hide them.
const describeCause = (
  cause: unknown,
): BetterAuthScriptFailureCause | undefined => {
  if (cause === undefined) {
    return undefined;
  }
  const described: BetterAuthScriptFailureCause = { names: [] };
  let current: unknown = cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) {
      described.names.push(typeof current);
      break;
    }
    described.names.push(current.name);
    described.code =
      readToken(current, "code", FIXED_VOCABULARY_CODE) ?? described.code;
    described.sqlState =
      readToken(current, "errno", SQLSTATE) ??
      readToken(current, "code", SQLSTATE) ??
      described.sqlState;
    if (current.cause === undefined) {
      break;
    }
    current = current.cause;
  }
  return described;
};

export const formatBetterAuthScriptFailure = ({
  cause,
  code,
  message,
}: BetterAuthScriptFailure) =>
  `${JSON.stringify({
    cause: describeCause(cause),
    code,
    message,
    status: "error",
  })}\n`;
