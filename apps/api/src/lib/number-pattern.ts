import { Result, TaggedError } from "better-result";

import {
  MATTER_REFERENCE_TOKENS,
  renderMatterReferencePattern,
  type MatterReferenceToken,
} from "@stll/api-contract";

class PatternError extends TaggedError("PatternError")<{
  message: string;
}> {}

const TOKEN_REGEX = /\{[^{}]+\}/gu;
const FORBIDDEN_CHARS = /[<>&]/u;
const BRACE_CHARS = /[{}]/u;

const MIN_PADDING = 1;
const MAX_PADDING = 6;
const MAX_REFERENCE_LENGTH = 64;

const TOKEN_RENDERED_LENGTH = {
  "{YYYY}": 4,
  "{YY}": 2,
  "{MM}": 2,
} as const satisfies Record<Exclude<MatterReferenceToken, "{SEQ}">, number>;

const isMatterReferenceToken = (token: string): token is MatterReferenceToken =>
  MATTER_REFERENCE_TOKENS.some((recognized) => recognized === token);

/** Validate a sequence pattern and its padding. */
export const validateNumberPattern = (
  pattern: string,
  padding: number,
): Result<true, PatternError> => {
  if (FORBIDDEN_CHARS.test(pattern)) {
    return Result.err(
      new PatternError({
        message: "Pattern must not contain <, >, or & characters",
      }),
    );
  }

  const tokens = Array.from(pattern.matchAll(TOKEN_REGEX), (match) => match[0]);
  if (BRACE_CHARS.test(pattern.replaceAll(TOKEN_REGEX, ""))) {
    return Result.err(
      new PatternError({
        message: "Pattern must not contain unmatched or nested braces",
      }),
    );
  }

  const seqCount = tokens.filter((token) => token === "{SEQ}").length;
  if (seqCount !== 1) {
    return Result.err(
      new PatternError({
        message: "Pattern must contain exactly one {SEQ} token",
      }),
    );
  }

  const unrecognizedToken = tokens.find(
    (token) => !isMatterReferenceToken(token),
  );
  if (unrecognizedToken !== undefined) {
    return Result.err(
      new PatternError({ message: `Unrecognized token: ${unrecognizedToken}` }),
    );
  }

  const recognizedTokens = tokens.filter(isMatterReferenceToken);
  if (padding < MIN_PADDING || padding > MAX_PADDING) {
    return Result.err(
      new PatternError({
        message: `Padding must be between ${MIN_PADDING} and ${MAX_PADDING}`,
      }),
    );
  }

  let renderedLength = pattern.length;
  for (const token of recognizedTokens) {
    const outputLength =
      token === "{SEQ}" ? MAX_PADDING : TOKEN_RENDERED_LENGTH[token];
    renderedLength += outputLength - token.length;
  }

  if (renderedLength > MAX_REFERENCE_LENGTH) {
    return Result.err(
      new PatternError({
        message: `Rendered reference would exceed ${MAX_REFERENCE_LENGTH} characters`,
      }),
    );
  }

  return Result.ok(true);
};

/** Resolve date tokens and remove {SEQ} to derive a counter scope key. */
export const toNumberPatternScopeKey = (pattern: string, now: Date): string =>
  renderMatterReferencePattern({ now, pattern, sequence: "" });
