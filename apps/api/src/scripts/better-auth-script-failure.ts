/**
 * One stderr line per Better Auth script failure. The scripts run where this
 * line is the only diagnostic channel, so it carries the tagged code, the
 * message, and a bounded description of the cause. Identity and token values
 * never flow through here: causes are database, filesystem, or network errors,
 * and their messages are scrubbed of row values before being emitted.
 */

const MAX_CAUSE_MESSAGE_LENGTH = 500;
const POSTGRES_KEY_DETAIL = /Key \([^)]*\)=\([^)]*\)/gu;
const SQLSTATE = /^[0-9A-Z]{5}$/u;

type BetterAuthScriptFailure = {
  cause?: unknown;
  code: string;
  message: string;
};

type BetterAuthScriptFailureCause = {
  errno?: string;
  message: string;
  name: string;
};

const describeCause = (
  cause: unknown,
): BetterAuthScriptFailureCause | undefined => {
  if (cause === undefined) {
    return undefined;
  }
  if (!(cause instanceof Error)) {
    return { message: "", name: typeof cause };
  }
  const message = cause.message
    .replaceAll(POSTGRES_KEY_DETAIL, "Key (redacted)")
    .slice(0, MAX_CAUSE_MESSAGE_LENGTH);
  const described: BetterAuthScriptFailureCause = { message, name: cause.name };
  for (const key of ["errno", "code"]) {
    const value = Reflect.get(cause, key);
    if (typeof value === "string" && SQLSTATE.test(value)) {
      described.errno = value;
    }
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
