/**
 * The agent-facing surface contract shared by the CLI (`@stll/anonymize-cli`)
 * and the MCP server (`@stll/anonymize-mcp`).
 *
 * Both surfaces are driven mostly by AI agents. To stay legible to them, every
 * tool/command failure carries one of a closed set of machine-readable `code`s
 * alongside a human `message` and an actionable `hint`; the MCP server returns
 * the `{ error: { code, message, hint, retryable } }` envelope with `isError`,
 * and the CLI maps the same `code` to a distinct process exit code. The two
 * surfaces do not talk to each other (the CLI drives the WASM engine directly),
 * so they share the taxonomy through this runtime-free module rather than a
 * call path.
 *
 * The set is closed: a new failure mode must reuse a code here or add one
 * deliberately (and pick a fresh exit code). This module must stay runtime-free
 * (no wasm, no node built-ins) so any consumer can import it cheaply.
 */

export const ANONYMIZE_ERROR_CODES = [
  /** Input failed validation at the boundary (shape, type, size, arguments). */
  "validation_error",
  /** A path resolved outside the configured roots, or was not absolute. */
  "path_not_allowed",
  /** The named input path or session key does not exist. */
  "not_found",
  /** The input's extension or content is not a supported document type. */
  "unsupported_format",
  /** The output path already exists; anonymize never overwrites. */
  "output_exists",
  /** A restore needs a durable session store that is not configured. */
  "session_unavailable",
  /** An external tool (pdftoppm, tesseract) was missing or not executable. */
  "dependency_missing",
  /** An unexpected internal failure; detail is not leaked to the caller. */
  "internal_error",
] as const;

export type AnonymizeErrorCode = (typeof ANONYMIZE_ERROR_CODES)[number];

/**
 * The structured tool-error envelope the MCP surface returns (alongside
 * `isError: true`). `hint` states the next step for the agent; `retryable`
 * says whether retrying the same call unchanged could plausibly succeed.
 */
export type AnonymizeErrorEnvelope = {
  error: {
    code: AnonymizeErrorCode;
    message: string;
    hint: string;
    retryable: boolean;
  };
};

/**
 * Process exit codes for the CLI. `ok`/`unexpected`/`usage` are the pre-existing
 * classes (0/1/2); the remaining classes are keyed off the error codes above so
 * an agent can branch on the exit code without parsing stderr. Every error code
 * maps to a distinct exit code (asserted in `agent-surface.test.ts`).
 */
export const EXIT_CODES = {
  ok: 0,
  unexpected: 1,
  usage: 2,
  pathNotAllowed: 3,
  notFound: 4,
  unsupportedFormat: 5,
  outputExists: 6,
  sessionUnavailable: 7,
  dependencyMissing: 8,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * Map every error code to its CLI exit class. `validation_error` shares the
 * `usage` class (2) with the CLI's own `UsageError`: both mean "the invocation
 * was malformed, fix the input". `internal_error` maps to the generic
 * `unexpected` class (1).
 */
export const ERROR_CODE_EXIT_MAP: Readonly<
  Record<AnonymizeErrorCode, ExitCode>
> = {
  validation_error: EXIT_CODES.usage,
  path_not_allowed: EXIT_CODES.pathNotAllowed,
  not_found: EXIT_CODES.notFound,
  unsupported_format: EXIT_CODES.unsupportedFormat,
  output_exists: EXIT_CODES.outputExists,
  session_unavailable: EXIT_CODES.sessionUnavailable,
  dependency_missing: EXIT_CODES.dependencyMissing,
  internal_error: EXIT_CODES.unexpected,
};

type SurfaceErrorOptions = {
  hint: string;
  retryable?: boolean;
  cause?: unknown;
};

/**
 * A failure carrying a stable agent-surface `code`, a `hint`, and a `retryable`
 * flag. Service and engine code throws this instead of a plain `Error` so both
 * surfaces can classify it: the MCP boundary renders it as the error envelope,
 * the CLI maps it to an exit code. Messages must stay content-free (never echo
 * raw input text or detected entities).
 */
export class AnonymizeSurfaceError extends Error {
  readonly code: AnonymizeErrorCode;
  readonly hint: string;
  readonly retryable: boolean;

  constructor(
    code: AnonymizeErrorCode,
    message: string,
    { hint, retryable = false, cause }: SurfaceErrorOptions,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AnonymizeSurfaceError";
    this.code = code;
    this.hint = hint;
    this.retryable = retryable;
  }
}

export const isAnonymizeSurfaceError = (
  value: unknown,
): value is AnonymizeSurfaceError => value instanceof AnonymizeSurfaceError;

/** Build the wire error envelope from a surface error. */
export const toErrorEnvelope = (
  error: AnonymizeSurfaceError,
): AnonymizeErrorEnvelope => ({
  error: {
    code: error.code,
    message: error.message,
    hint: error.hint,
    retryable: error.retryable,
  },
});

/**
 * Classify an arbitrary thrown value into the error envelope. A
 * `AnonymizeSurfaceError` keeps its code; anything else collapses to
 * `internal_error` with its detail withheld, so unexpected failures never leak
 * raw text or stack detail to the caller.
 */
export const classifyToEnvelope = (error: unknown): AnonymizeErrorEnvelope => {
  if (isAnonymizeSurfaceError(error)) {
    return toErrorEnvelope(error);
  }
  return {
    error: {
      code: "internal_error",
      message: "The operation failed unexpectedly.",
      hint: "Retry; if it persists, file it with the send_feedback tool.",
      retryable: true,
    },
  };
};

/** The CLI exit code for a thrown value (non-surface errors are `unexpected`). */
export const exitCodeForError = (error: unknown): ExitCode =>
  isAnonymizeSurfaceError(error)
    ? ERROR_CODE_EXIT_MAP[error.code]
    : EXIT_CODES.unexpected;
