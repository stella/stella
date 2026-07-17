import { isTaggedError } from "better-result";
import { appendFile, mkdir, stat, truncate } from "node:fs/promises";
import path from "node:path";

import { createDevErrorLogger } from "@stll/errors";

import { envBase } from "@/api/env-base";
import { pgErrorFields } from "@/api/lib/pg-error";

/**
 * Extract a safe, structural error identifier for observability.
 *
 * Returns the TaggedError `_tag`, the Error constructor name, or
 * "UnknownError". Never includes messages, causes, or stack
 * traces; those may contain privileged document content, file
 * names, or client data that must not reach analytics dashboards.
 */
export const errorTag = (error: unknown): string => {
  if (isTaggedError(error)) {
    return error._tag;
  }
  if (error instanceof Error) {
    return errorClassName(error);
  }
  return "UnknownError";
};

/**
 * Non-PII connection/system fields for infra observability.
 *
 * Network, socket, TLS and DNS failures carry structured fields —
 * `code` (ECONNRESET, ETIMEDOUT, EAI_AGAIN…), `errno`, `syscall` —
 * that pinpoint the failure without any client data. Unlike
 * `error.message`, these are safe to ship to analytics dashboards,
 * so this extends `errorTag` rather than replacing it.
 */
export const errorSystemFields = (error: unknown): Record<string, string> => {
  const fields: Record<string, string> = { "error.type": errorTag(error) };
  if (!(error instanceof Error)) {
    return fields;
  }
  const code = safeErrorCode(error);
  if (code !== undefined) {
    fields["error.code"] = code;
  }
  const errno = safeErrorNumberProperty(error, "errno");
  if (errno !== undefined) {
    fields["error.errno"] = String(errno);
  }
  const syscall = safeErrorStringProperty(error, "syscall");
  if (syscall !== undefined) {
    fields["error.syscall"] = syscall;
  }
  const cause = safeErrorCause(error);
  if (cause !== undefined) {
    fields["error.cause.type"] = errorTag(cause);
    if (cause instanceof Error) {
      const causeCode = safeErrorCode(cause);
      if (causeCode !== undefined) {
        fields["error.cause.code"] = causeCode;
      }
    }
  }
  return fields;
};

/**
 * `errorSystemFields` plus the raw error message under `error.msg`.
 *
 * ONLY for infra sinks that exclusively observe connection-level
 * failures — Redis/BullMQ `worker.on("error")` and the SSE pub/sub
 * subscriber. Those errors are socket/TLS/Redis-protocol messages
 * ("Connection is closed", "read ECONNRESET"), never document
 * content or client data, so surfacing the message stays non-PII
 * while making the failure diagnosable. Do NOT use at sinks that
 * can observe handler or user-data errors; keep those on `errorTag`
 * or `errorSystemFields`.
 *
 * The key is `error.msg`, not `error.message`: the logger's
 * `sanitizeLogAttributes` drops any attribute key matching /message/i
 * as a blanket PII guard, which would silently strip the value.
 * `msg` sidesteps that drop; the connection-only scope above is what
 * keeps surfacing the message safe. See utils.test.ts for the
 * sanitizer-survival guard.
 */
export const connectionErrorFields = (
  error: unknown,
): Record<string, string> => {
  const fields = errorSystemFields(error);
  if (error instanceof Error) {
    const message = safeErrorMessage(error);
    if (message !== undefined) {
      fields["error.msg"] = message;
    }
  }
  return fields;
};

const safeErrorStringProperty = (
  error: Error,
  key: string,
): string | undefined => {
  try {
    if (!(key in error)) {
      return undefined;
    }
    const value: unknown = Reflect.get(error, key);
    if (typeof value === "string" && value) {
      return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const safeErrorNumberProperty = (
  error: Error,
  key: string,
): number | undefined => {
  try {
    if (!(key in error)) {
      return undefined;
    }
    const value: unknown = Reflect.get(error, key);
    if (typeof value === "number") {
      return value;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

export const safeErrorCause = (error: Error): unknown => {
  try {
    return Reflect.get(error, "cause");
  } catch {
    return undefined;
  }
};

const errorClassName = (error: Error): string => {
  try {
    const constructorValue: unknown = Reflect.get(error, "constructor");
    if (typeof constructorValue !== "function") {
      return "Error";
    }
    const name: unknown = Reflect.get(constructorValue, "name");
    if (typeof name === "string" && name) {
      return name;
    }
  } catch {
    return "Error";
  }
  return "Error";
};

const safeErrorCode = (error: Error): string | undefined =>
  safeErrorStringProperty(error, "code");

const safeErrorMessage = (error: Error): string | undefined =>
  safeErrorStringProperty(error, "message");

const safeErrorStack = (error: Error): string | undefined =>
  safeErrorStringProperty(error, "stack");

/**
 * Raw diagnostics for an explicitly enabled break-glass log path.
 * This may include client data; never send it to analytics.
 */
export const unredactedErrorFields = (
  error: unknown,
): Record<string, string> => {
  const fields: Record<string, string> = {};
  if (!(error instanceof Error)) {
    return fields;
  }

  const message = safeErrorMessage(error);
  if (message !== undefined) {
    fields["error.msg"] = message;
  }
  const stack = safeErrorStack(error);
  if (stack !== undefined) {
    fields["error.stack"] = stack;
  }
  return fields;
};

/**
 * Non-PII structural fingerprint for diagnosing 5xx without shipping
 * any user data. Three signals, all code-level, never content:
 *  - `error.class`: the constructor name (e.g. "Panic", "TypeError").
 *  - `error.code`: a stable code — a `.code` string when present
 *    (HandlerError code, ECONNRESET, …), otherwise the structural tag.
 *  - `error.frame`: the top stack frame as `file:line:col`, plus the
 *    deepest `.cause`'s top frame under `error.cause.frame`.
 *
 * A class name, error code, and `file:line:col` code location carry no
 * client data, so they are safe at any sink. The attribute keys are
 * chosen to NOT match the logger's PII redaction regex
 * (`/(?:body|content|email|fileName|message|name|title)/i`), so they
 * survive `sanitizeLogAttributes`. Stack parsing is fully defensive:
 * `stack` may be undefined, multiline, or minified. The message prefix
 * is skipped before frame detection because user content may itself
 * contain lines shaped like stack frames. This never throws; a missing
 * frame is simply omitted.
 */
export type ErrorFingerprint = Record<string, string>;

const STACK_FRAME_PREFIX = "at ";

const isAsciiDigits = (value: string): boolean => {
  if (!value) {
    return false;
  }
  for (const char of value) {
    if (char < "0" || char > "9") {
      return false;
    }
  }
  return true;
};

const hasWhitespace = (value: string): boolean => {
  for (const char of value) {
    if (char.trim() === "") {
      return true;
    }
  }
  return false;
};

const frameLocation = (line: string): string | undefined => {
  const trimmedStart = line.trimStart();
  if (trimmedStart === line || !trimmedStart.startsWith(STACK_FRAME_PREFIX)) {
    return undefined;
  }

  const locationEnd = trimmedStart.endsWith(")")
    ? trimmedStart.length - 1
    : trimmedStart.length;
  const columnSeparator = trimmedStart.lastIndexOf(":", locationEnd - 1);
  if (columnSeparator === -1) {
    return undefined;
  }
  const lineSeparator = trimmedStart.lastIndexOf(":", columnSeparator - 1);
  if (lineSeparator === -1) {
    return undefined;
  }

  const lineNumber = trimmedStart.slice(lineSeparator + 1, columnSeparator);
  const columnNumber = trimmedStart.slice(columnSeparator + 1, locationEnd);
  if (!isAsciiDigits(lineNumber) || !isAsciiDigits(columnNumber)) {
    return undefined;
  }

  const openingParen = trimmedStart.lastIndexOf("(", lineSeparator);
  const locationStart =
    openingParen === -1 ? STACK_FRAME_PREFIX.length : openingParen + 1;
  const location = trimmedStart.slice(locationStart, locationEnd);
  if (!location || hasWhitespace(location)) {
    return undefined;
  }
  return location;
};

const stackFrameLines = (error: Error, stack: string): string[] => {
  const message = safeErrorMessage(error);
  if (message === undefined) {
    return [];
  }

  const lines = stack.split("\n");
  const firstLine = lines.at(0);
  if (firstLine === undefined) {
    return [];
  }

  const messageLines = message.split("\n");
  const firstMessageLine = messageLines.at(0);
  if (firstMessageLine && !firstLine.endsWith(firstMessageLine)) {
    return [];
  }

  return lines.slice(messageLines.length);
};

const topStackFrame = (error: Error): string | undefined => {
  try {
    const stack = safeErrorStack(error);
    if (stack === undefined) {
      return undefined;
    }
    for (const line of stackFrameLines(error, stack)) {
      const location = frameLocation(line);
      if (location) {
        return location;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const stableErrorCode = (error: Error): string =>
  safeErrorCode(error) ?? errorTag(error);

const deepestCause = (error: Error): Error | undefined => {
  try {
    const seen = new WeakSet<object>([error]);
    let current = safeErrorCause(error);
    let deepest: Error | undefined;
    let depth = 0;
    while (current instanceof Error && depth < 5 && !seen.has(current)) {
      seen.add(current);
      deepest = current;
      current = safeErrorCause(current);
      depth += 1;
    }
    return deepest;
  } catch {
    return undefined;
  }
};

export const errorFingerprint = (error: unknown): ErrorFingerprint => {
  if (!(error instanceof Error)) {
    return { "error.class": "UnknownError" };
  }
  const fingerprint: ErrorFingerprint = {
    "error.class": errorClassName(error),
    "error.code": stableErrorCode(error),
  };
  const frame = topStackFrame(error);
  if (frame !== undefined) {
    fingerprint["error.frame"] = frame;
  }
  const cause = deepestCause(error);
  if (cause) {
    const causeFrame = topStackFrame(cause);
    if (causeFrame !== undefined) {
      fingerprint["error.cause.frame"] = causeFrame;
    }
  }
  // A Drizzle query failure wraps the driver's PostgresError as a cause; its
  // SQLSTATE and schema identifiers are the actionable, non-PII detail. Without
  // this the 5xx fingerprint carries only error types, and diagnosis needs the
  // RDS server logs.
  Object.assign(fingerprint, pgErrorFields(error));
  return fingerprint;
};

/**
 * Surface an error in dev. Two sinks:
 *  1) `console.error` — the interactive dev terminal sees it now.
 *  2) `apps/api/.dev-logs/errors.jsonl` — headless tools (CI repro
 *     scripts, AI agents, second tmux pane) can `tail` it without
 *     needing the original tty.
 *
 * Both are no-ops outside dev. Only ever called from
 * `captureError`, which has already decided the error is real and
 * non-PII for *local* logging — the analytics pipeline still gets
 * just the structural tag.
 */
// The JSONL file sink is injected lazily (inside the arrow, not passed
// by reference) so it is resolved at call time, after `appendDevErrorJsonl`
// below has initialized — a direct reference here would hit its TDZ during
// module evaluation.
export const logDevError = createDevErrorLogger({
  isDev: envBase.isDev,
  sink: ({ error, context }) => {
    void appendDevErrorJsonl({ error, context });
  },
});

// ── JSONL sink for dev errors ──────────────────────────

// Resolve apps/api/.dev-logs/errors.jsonl regardless of where the
// process was launched from — `import.meta.dir` points at this
// file's directory; we walk up to apps/api.
const DEV_LOG_PATH = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  ".dev-logs",
  "errors.jsonl",
);

// Don't let the file grow unbounded across long dev sessions.
// 5 MiB is far more than anyone will scroll through; once we
// cross it we just empty the file and start over. Simple beats
// rotation for a dev-only convenience log.
const MAX_BYTES = 5 * 1024 * 1024;

let dirReady: Promise<void> | null = null;
const ensureLogDir = async (): Promise<void> => {
  dirReady ??= mkdir(path.dirname(DEV_LOG_PATH), { recursive: true }).then(
    () => undefined,
  );
  await dirReady;
};

type SerializedError = {
  name: string;
  message: string;
  tag?: string;
  stack?: string;
  cause?: unknown;
};

const serializeError = (error: unknown): unknown => {
  if (error instanceof Error) {
    const stack = safeErrorStack(error);
    const cause = safeErrorCause(error);
    const out: SerializedError = {
      name: errorClassName(error),
      message: safeErrorMessage(error) ?? "",
      ...(stack !== undefined && { stack }),
      ...(isTaggedError(error) && { tag: error._tag }),
      ...(cause !== undefined && { cause: serializeError(cause) }),
    };
    return out;
  }
  return error;
};

type AppendDevErrorJsonlInput = {
  error: unknown;
  context?: Record<string, unknown> | undefined;
};

const appendDevErrorJsonl = async ({
  error,
  context,
}: AppendDevErrorJsonlInput): Promise<void> => {
  try {
    await ensureLogDir();

    // Cap-and-truncate: if the file is over the limit, reset it
    // before appending. `stat` throws for missing files — that's
    // fine, the append below will create a fresh one.
    try {
      const fileStat = await stat(DEV_LOG_PATH);
      if (fileStat.size > MAX_BYTES) {
        await truncate(DEV_LOG_PATH, 0);
      }
    } catch {
      // file doesn't exist yet — appendFile will create it
    }

    const record = {
      when: new Date().toISOString(),
      tag: errorTag(error),
      ...(context && Object.keys(context).length > 0 ? { context } : {}),
      error: serializeError(error),
    };

    await appendFile(DEV_LOG_PATH, `${JSON.stringify(record)}\n`);
  } catch {
    // Best effort. If the dev log sink is broken we don't want to
    // mask the original error — `console.error` already fired.
  }
};
