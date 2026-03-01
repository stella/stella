import { Result, TaggedError } from "better-result";

export class PatternError extends TaggedError("PatternError")<{
  message: string;
}>() {}

const RECOGNIZED_TOKENS = ["{SEQ}", "{YYYY}", "{YY}", "{MM}"] as const;
const TOKEN_REGEX = /\{[^}]+\}/g;
const FORBIDDEN_CHARS = /[<>&]/;

const MIN_PADDING = 1;
const MAX_PADDING = 6;
const MAX_REFERENCE_LENGTH = 64;

const TOKEN_RENDERED_LENGTH: Record<string, number> = {
  "{YYYY}": 4,
  "{YY}": 2,
  "{MM}": 2,
};

export const DEFAULT_MATTER_NUMBER_PATTERN = "{SEQ}";
export const DEFAULT_MATTER_NUMBER_PADDING = 3;

/**
 * Validates a matter number pattern.
 *
 * Rules:
 * 1. Must contain exactly one {SEQ}.
 * 2. Only recognized tokens allowed.
 * 3. Rendered reference must fit in 64 characters.
 * 4. No <, >, & characters.
 * 5. Padding between 1 and 6.
 */
export const validatePattern = (
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

  const tokens = pattern.match(TOKEN_REGEX) ?? [];
  const seqCount = tokens.filter((t) => t === "{SEQ}").length;

  if (seqCount !== 1) {
    return Result.err(
      new PatternError({
        message: "Pattern must contain exactly one {SEQ} token",
      }),
    );
  }

  for (const token of tokens) {
    if (
      !RECOGNIZED_TOKENS.includes(token as (typeof RECOGNIZED_TOKENS)[number])
    ) {
      return Result.err(
        new PatternError({
          message: `Unrecognized token: ${token}`,
        }),
      );
    }
  }

  if (padding < MIN_PADDING || padding > MAX_PADDING) {
    return Result.err(
      new PatternError({
        message: `Padding must be between ${MIN_PADDING} and ${MAX_PADDING}`,
      }),
    );
  }

  // Compute worst-case rendered length: literal chars + token outputs.
  // Use MAX_PADDING for {SEQ} since padStart only sets a minimum width;
  // actual sequences can exceed the padding value.
  let renderedLength = pattern.length;
  for (const token of tokens) {
    const outputLen =
      token === "{SEQ}" ? MAX_PADDING : (TOKEN_RENDERED_LENGTH[token] ?? 0);
    renderedLength += outputLen - token.length;
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

/**
 * Derives the scope key from a pattern by resolving date tokens
 * and removing {SEQ}. Used to partition counters so they reset
 * when the date segment changes.
 *
 * Examples (given 2026-02-20):
 * - "{YYYY}/{SEQ}" -> "2026/"
 * - "{YYYY}-{MM}/{SEQ}" -> "2026-02/"
 * - "LIT-{SEQ}" -> "LIT-"
 * - "{SEQ}" -> ""
 */
export const toScopeKey = (pattern: string, now: Date): string => {
  const yyyy = String(now.getFullYear());
  const yy = yyyy.slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");

  return pattern
    .replaceAll("{YYYY}", yyyy)
    .replaceAll("{YY}", yy)
    .replaceAll("{MM}", mm)
    .replaceAll("{SEQ}", "");
};

/**
 * Renders a full reference by replacing all tokens in-place.
 * {SEQ} is replaced with the zero-padded sequence number;
 * date tokens are resolved from `now`.
 *
 * Examples (given 2026-02-20, seq=1, padding=3):
 * - "{YYYY}/{SEQ}" -> "2026/001"
 * - "CORP-{SEQ}-{YYYY}" -> "CORP-001-2026"
 * - "{SEQ}" -> "001"
 */
export const toReference = (
  pattern: string,
  now: Date,
  seq: number,
  padding: number,
): string => {
  const yyyy = String(now.getFullYear());
  const yy = yyyy.slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const paddedSeq = String(seq).padStart(padding, "0");

  return pattern
    .replaceAll("{YYYY}", yyyy)
    .replaceAll("{YY}", yy)
    .replaceAll("{MM}", mm)
    .replaceAll("{SEQ}", paddedSeq);
};
