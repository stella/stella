import { Result, TaggedError } from "better-result";

export class InvalidNumericTokenError extends TaggedError(
  "InvalidNumericTokenError",
)<{
  message: string;
  reason: "syntax" | "unsafe-integer" | "non-finite" | "out-of-range";
}> {}

export type NumericTokenOptions = {
  /** Signed by default; unsigned tokens reject even the spelling `-0`. */
  sign?: "signed" | "unsigned";
  min?: number;
  max?: number;
};

const SIGNED_INTEGER = /^-?[0-9]+(?![\s\S])/u;
const UNSIGNED_INTEGER = /^[0-9]+(?![\s\S])/u;
/** Base-ten digits, with an optional fraction containing at least one digit. */
const SIGNED_DECIMAL = /^-?[0-9]+(?:\.[0-9]+)?(?![\s\S])/u;
const UNSIGNED_DECIMAL = /^[0-9]+(?:\.[0-9]+)?(?![\s\S])/u;

const inRange = (value: number, { min, max }: NumericTokenOptions) => {
  if (
    (min !== undefined && value < min) ||
    (max !== undefined && value > max)
  ) {
    return Result.err(
      new InvalidNumericTokenError({
        reason: "out-of-range",
        message: "Numeric token is outside the permitted range",
      }),
    );
  }
  return Result.ok(value);
};

/** Parse an entire ASCII decimal integer token; no trimming or prefix coercion. */
export const parseIntegerToken = (
  input: unknown,
  options: NumericTokenOptions = {},
): Result<number, InvalidNumericTokenError> => {
  const grammar =
    options.sign === "unsigned" ? UNSIGNED_INTEGER : SIGNED_INTEGER;
  if (typeof input !== "string" || !grammar.test(input)) {
    return Result.err(
      new InvalidNumericTokenError({
        reason: "syntax",
        message: "Expected a whole decimal integer token",
      }),
    );
  }
  const value = Number(input);
  if (!Number.isSafeInteger(value)) {
    return Result.err(
      new InvalidNumericTokenError({
        reason: "unsafe-integer",
        message: "Integer token exceeds the safe integer range",
      }),
    );
  }
  return inRange(value, options);
};

/** Grammar: `-?[0-9]+(\.[0-9]+)?`; no grouping, exponent or implicit whitespace. */
export const parseDecimalToken = (
  input: unknown,
  options: NumericTokenOptions = {},
): Result<number, InvalidNumericTokenError> => {
  const grammar =
    options.sign === "unsigned" ? UNSIGNED_DECIMAL : SIGNED_DECIMAL;
  if (typeof input !== "string" || !grammar.test(input)) {
    return Result.err(
      new InvalidNumericTokenError({
        reason: "syntax",
        message: "Expected a whole decimal token",
      }),
    );
  }
  const value = Number(input);
  if (!Number.isFinite(value)) {
    return Result.err(
      new InvalidNumericTokenError({
        reason: "non-finite",
        message: "Decimal token must be finite",
      }),
    );
  }
  return inRange(value, options);
};
