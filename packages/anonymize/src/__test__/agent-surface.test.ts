import { describe, expect, test } from "bun:test";

import {
  ANONYMIZE_ERROR_CODES,
  AnonymizeSurfaceError,
  ERROR_CODE_EXIT_MAP,
  EXIT_CODES,
  classifyToEnvelope,
  exitCodeForError,
  toErrorEnvelope,
} from "../agent-surface";

describe("agent-surface exit map", () => {
  test("maps every error code to an exit class", () => {
    for (const code of ANONYMIZE_ERROR_CODES) {
      expect(ERROR_CODE_EXIT_MAP[code]).toBeDefined();
    }
    expect(Object.keys(ERROR_CODE_EXIT_MAP).sort()).toEqual(
      [...ANONYMIZE_ERROR_CODES].sort(),
    );
  });

  // The whole point of distinct exit codes is that an agent can branch on the
  // exit code alone. Two codes sharing an exit would silently collapse that.
  // `validation_error` deliberately shares `usage` with the CLI's own
  // UsageError, so it is excluded from the injectivity check.
  test("assigns a distinct exit code to every code except validation_error", () => {
    const exits = ANONYMIZE_ERROR_CODES.filter(
      (code) => code !== "validation_error",
    ).map((code) => ERROR_CODE_EXIT_MAP[code]);
    expect(new Set(exits).size).toBe(exits.length);
  });

  test("validation_error shares the usage exit class", () => {
    expect(ERROR_CODE_EXIT_MAP.validation_error).toBe(EXIT_CODES.usage);
  });
});

describe("AnonymizeSurfaceError", () => {
  test("renders to the error envelope", () => {
    const error = new AnonymizeSurfaceError("not_found", "No such input.", {
      hint: "Check the path.",
    });
    expect(toErrorEnvelope(error)).toEqual({
      error: {
        code: "not_found",
        message: "No such input.",
        hint: "Check the path.",
        retryable: false,
      },
    });
    expect(exitCodeForError(error)).toBe(EXIT_CODES.notFound);
  });

  test("carries retryable and cause when provided", () => {
    const cause = new Error("underlying");
    const error = new AnonymizeSurfaceError("internal_error", "Boom.", {
      hint: "Retry.",
      retryable: true,
      cause,
    });
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
  });
});

describe("classification of unknown errors", () => {
  test("collapses a plain error to internal_error without leaking detail", () => {
    const envelope = classifyToEnvelope(new Error("raw secret detail"));
    expect(envelope.error.code).toBe("internal_error");
    expect(envelope.error.message).not.toContain("secret");
    expect(exitCodeForError(new Error("x"))).toBe(EXIT_CODES.unexpected);
  });
});
