// Headless fallback: the user completes the OAuth flow in any browser (not
// necessarily one reachable from the CLI's machine) and pastes back either
// the full redirected URL or the bare `code` value.

import { Result } from "better-result";

import { ManualCallbackParseError } from "./errors.js";

export type ParsedManualCallback = {
  readonly code: string;
  /** `undefined` when the user pasted a bare code and no state could be checked. */
  readonly state: string | undefined;
};

/**
 * Parses manual-paste input. Accepts a full redirect URL (`http://127.0.0.1/
 * callback?code=...&state=...`) or a bare authorization code.
 */
export const parseManualCallbackInput = (
  input: string,
): Result<ParsedManualCallback, ManualCallbackParseError> => {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return Result.err(
      new ManualCallbackParseError({ message: "No input provided" }),
    );
  }

  if (!trimmed.includes("://")) {
    return Result.ok({ code: trimmed, state: undefined });
  }

  const parsedUrl = Result.try(() => new URL(trimmed));
  if (Result.isError(parsedUrl)) {
    return Result.err(
      new ManualCallbackParseError({
        message: `Could not parse "${trimmed}" as a URL or a bare authorization code`,
      }),
    );
  }

  const error = parsedUrl.value.searchParams.get("error");
  if (error) {
    const description = parsedUrl.value.searchParams.get("error_description");
    return Result.err(
      new ManualCallbackParseError({
        message: description ?? error,
      }),
    );
  }

  const code = parsedUrl.value.searchParams.get("code");
  if (!code) {
    return Result.err(
      new ManualCallbackParseError({
        message: "The pasted URL has no `code` query parameter",
      }),
    );
  }

  return Result.ok({
    code,
    state: parsedUrl.value.searchParams.get("state") ?? undefined,
  });
};
