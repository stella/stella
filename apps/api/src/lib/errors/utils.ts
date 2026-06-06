import { isTaggedError } from "better-result";
import { appendFile, mkdir, stat, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";

import { envBase } from "@/api/env-base";

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
    return error.constructor.name;
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
  if ("code" in error && typeof error.code === "string") {
    fields["error.code"] = error.code;
  }
  if ("errno" in error && typeof error.errno === "number") {
    fields["error.errno"] = String(error.errno);
  }
  if ("syscall" in error && typeof error.syscall === "string") {
    fields["error.syscall"] = error.syscall;
  }
  if (error.cause !== undefined) {
    fields["error.cause.type"] = errorTag(error.cause);
    if (
      error.cause instanceof Error &&
      "code" in error.cause &&
      typeof error.cause.code === "string"
    ) {
      fields["error.cause.code"] = error.cause.code;
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
  if (error instanceof Error && error.message) {
    fields["error.msg"] = error.message;
  }
  return fields;
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
export const logDevError = (
  error: unknown,
  context?: Record<string, unknown>,
) => {
  if (!envBase.isDev) {
    return;
  }
  // eslint-disable-next-line no-console
  console.error(error);
  void appendDevErrorJsonl({ error, context });
};

// ── JSONL sink for dev errors ──────────────────────────

// Resolve apps/api/.dev-logs/errors.jsonl regardless of where the
// process was launched from — `import.meta.dir` points at this
// file's directory; we walk up to apps/api.
const DEV_LOG_PATH = join(
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
  dirReady ??= mkdir(dirname(DEV_LOG_PATH), { recursive: true }).then(
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
    const out: SerializedError = {
      name: error.constructor.name,
      message: error.message,
      ...(error.stack !== undefined && { stack: error.stack }),
      ...(isTaggedError(error) && { tag: error._tag }),
      ...(error.cause !== undefined && { cause: serializeError(error.cause) }),
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
