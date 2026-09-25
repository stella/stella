import { isTaggedError } from "better-result";
import { appendFile, mkdir, stat, truncate } from "node:fs/promises";
import path from "node:path";

import { createDevErrorLogger } from "@stll/errors";
import { Temporal } from "@stll/time";

import { envBase } from "@/api/env-base";
import {
  errorClassName,
  errorTag,
  isErrorInstance,
} from "@/api/lib/errors/error-tag";
import { ExtractionWorkerError } from "@/api/lib/errors/tagged-errors";
import {
  identityFields,
  shadowGradeFields,
  systemFields,
} from "@/api/lib/observability/failure";
import { readEvidence } from "@/api/lib/observability/failure-evidence";

// Re-exported so callers keep one import path, while modules that must not
// pay this file's import-time env read can take it from the split module.
export { errorTag };

/**
 * Non-PII connection/system fields for infra observability.
 *
 * Network, socket, TLS and DNS failures carry structured fields —
 * `code` (ECONNRESET, ETIMEDOUT, EAI_AGAIN…), `errno`, `syscall` —
 * that pinpoint the failure without any client data. Unlike
 * `error.message`, these are safe to ship to analytics dashboards,
 * so this extends `errorTag` rather than replacing it.
 */
export const errorSystemFields = (error: unknown): Record<string, string> => ({
  ...systemFields(readEvidence(error)),
  ...shadowGradeFields(error),
});

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
  if (isErrorInstance(error)) {
    const message = safeErrorMessage(error);
    if (message !== undefined) {
      fields["error.msg"] = message;
    }
  }
  return fields;
};

/**
 * Typed, non-content diagnostics that every error capture may safely attach.
 * Keep this exhaustive per supported error class so callers cannot forget
 * fields on one execution path, while messages, names, and document bytes
 * remain excluded by construction.
 */
export const safeErrorTelemetryFields = (
  error: unknown,
): Record<string, string> => {
  if (!(error instanceof ExtractionWorkerError)) {
    return {};
  }
  const fields = {
    mimeType: error.mimeType,
    sizeBytes: String(error.sizeBytes),
  };
  if (error.termination !== null) {
    return {
      ...fields,
      signalCode: error.termination.signalCode,
      terminationReason: error.termination.reason,
    };
  }
  return { ...fields, exitCode: String(error.exitCode) };
};

const safeErrorProperty = (error: Error, key: string): unknown => {
  try {
    return key in error ? Reflect.get(error, key) : undefined;
  } catch {
    return undefined;
  }
};

const safeErrorStringProperty = (
  error: Error,
  key: string,
): string | undefined => {
  const value = safeErrorProperty(error, key);
  return typeof value === "string" && value !== "" ? value : undefined;
};

const safeErrorCause = (error: Error): unknown => {
  try {
    return Reflect.get(error, "cause");
  } catch {
    return undefined;
  }
};

export const safeErrorCode = (error: Error): string | undefined =>
  safeErrorStringProperty(error, "code") ??
  // An AWS SDK service exception carries its service error code as `name`,
  // and marks itself with `$fault`; any other error's name is its class.
  (safeErrorProperty(error, "$fault") === undefined
    ? undefined
    : safeErrorStringProperty(error, "name"));

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
 *  - `error.class`: the class name (e.g. "Panic", "TypeError").
 *  - `error.code`: a stable code — a `.code` string when present
 *    (HandlerError code, ECONNRESET, …), otherwise the structural tag.
 *  - `error.frame`: the top stack frame as `file:line:col`, plus the
 *    deepest `.cause`'s top frame under `error.cause.frame`.
 *
 * A class name, error code, and `file:line:col` code location carry no
 * client data, so they are safe at any sink. The attribute keys are
 * chosen to NOT match the logger's PII redaction regex, so they survive
 * `sanitizeLogAttributes`. The fields are read from the shared failure
 * snapshot (`failure-evidence.ts`), which also owns the defensive stack
 * parsing, and carry the grade the failure would get.
 *
 * A Drizzle query failure wraps the driver's PostgresError as a cause; its
 * SQLSTATE and schema identifiers are the actionable, non-PII detail, so the
 * pg fields ride along.
 */
export type ErrorFingerprint = Record<string, string>;

export const errorFingerprint = (error: unknown): ErrorFingerprint => ({
  ...identityFields(readEvidence(error)),
  ...shadowGradeFields(error),
});

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
export const logServerDevError = createDevErrorLogger({
  isDev: envBase.isDev,
  sink: ({ error, context }) => {
    devLogWrites = devLogWrites.then(
      async () => await appendDevErrorJsonl({ error, context }),
    );
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

// Appends run one at a time so a size-cap truncate cannot interleave with
// another record's append. `appendDevErrorJsonl` never rejects (its failures
// cannot route through the error-capture channel, which logs back through
// here), so the chain never rejects either.
let devLogWrites: Promise<void> = Promise.resolve();

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
      when: Temporal.Now.instant().toString({ fractionalSecondDigits: 3 }),
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
