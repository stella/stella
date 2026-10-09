import { Result, TaggedError } from "better-result";
import * as v from "valibot";

/** An inclusive range of court-assigned paragraph numbers. */
export type DecisionParagraphRange = {
  readonly from: number;
  readonly to: number;
};

const MAX_DECISION_PARAGRAPH_RANGE_SPAN = 500;
const MAX_DECISION_PARAGRAPH_RANGE_INPUT_CHARS = 33;
// Group-free so the published JSON Schema pattern is portable across validators.
const PARAGRAPH_RANGE_PATTERN = /^\d+(?:[-–]\d+)?$/u;
const PARAGRAPH_RANGE_SEPARATOR = /[-–]/u;

export type DecisionParagraphRangeErrorReason =
  | "garbage"
  | "reversed"
  | "too-wide";

export class DecisionParagraphRangeError extends TaggedError(
  "DecisionParagraphRangeError",
)<{
  message: string;
  reason: DecisionParagraphRangeErrorReason;
}> {}

const invalidRange = (
  reason: DecisionParagraphRangeErrorReason,
  message: string,
) => Result.err(new DecisionParagraphRangeError({ message, reason }));

const rangeFromString = (input: string): DecisionParagraphRange | null => {
  if (
    input.length > MAX_DECISION_PARAGRAPH_RANGE_INPUT_CHARS ||
    !PARAGRAPH_RANGE_PATTERN.test(input)
  ) {
    return null;
  }
  const [fromText, toText] = input.split(PARAGRAPH_RANGE_SEPARATOR);
  const from = Number(fromText);
  const to = toText === undefined ? from : Number(toText);
  if (
    !Number.isSafeInteger(from) ||
    from < 1 ||
    !Number.isSafeInteger(to) ||
    to < 1
  ) {
    return null;
  }
  return { from, to };
};

/** Parse `48`, `48-53`, or `48–53` into an inclusive court paragraph range. */
export const parseDecisionParagraphRange = (input: string) => {
  const range = rangeFromString(input);
  if (range === null) {
    return invalidRange(
      "garbage",
      "Expected a positive safe paragraph number or range",
    );
  }
  if (range.from > range.to) {
    return invalidRange("reversed", "Paragraph range ends before it starts");
  }
  if (range.to - range.from + 1 > MAX_DECISION_PARAGRAPH_RANGE_SPAN) {
    return invalidRange(
      "too-wide",
      "Paragraph range may span at most 500 numbers",
    );
  }
  return Result.ok(range);
};

const parseErrorReasonOf = (
  input: string,
): DecisionParagraphRangeErrorReason | null => {
  const parsed = parseDecisionParagraphRange(input);
  return Result.isError(parsed) ? parsed.error.reason : null;
};

const garbageCheck = v.check(
  (input: string) => parseErrorReasonOf(input) !== "garbage",
  "Expected a positive safe paragraph number or range",
);
const reversedCheck = v.check(
  (input: string) => parseErrorReasonOf(input) !== "reversed",
  "Paragraph range ends before it starts",
);
const tooWideCheck = v.check(
  (input: string) => parseErrorReasonOf(input) !== "too-wide",
  "Paragraph range may span at most 500 numbers",
);

/**
 * Checks JSON Schema cannot express. A converter publishes the remaining
 * bounded, patterned string and leaves these to runtime validation.
 */
export const DECISION_PARAGRAPH_RANGE_RUNTIME_ONLY_CHECKS = [
  garbageCheck,
  reversedCheck,
  tooWideCheck,
] as const;

/**
 * A Valibot wire schema whose advertised input stays a string. The
 * description precedes the transform: an input-mode JSON Schema projection
 * stops at the first transformation and would drop a trailing description.
 */
export const decisionParagraphRangeSchema = (
  description: string,
): v.GenericSchema<string, DecisionParagraphRange> =>
  v.pipe(
    v.string(),
    v.description(description),
    v.maxLength(MAX_DECISION_PARAGRAPH_RANGE_INPUT_CHARS),
    garbageCheck,
    v.regex(PARAGRAPH_RANGE_PATTERN),
    reversedCheck,
    tooWideCheck,
    v.transform((input) => {
      const [fromText, toText] = input.split(PARAGRAPH_RANGE_SEPARATOR);
      const from = Number(fromText);
      return { from, to: toText === undefined ? from : Number(toText) };
    }),
  );

/** Canonical spelling for a court paragraph range. */
export const formatDecisionParagraphRange = ({
  from,
  to,
}: DecisionParagraphRange): string =>
  from === to ? String(from) : `${String(from)}-${String(to)}`;

/** The hash fragment value used to address a paragraph or paragraph range. */
export const decisionParagraphFragment = (
  range: DecisionParagraphRange,
): string => `par=${formatDecisionParagraphRange(range)}`;

/** Read either a URL hash or its fragment value; malformed values have no target. */
export const parseDecisionParagraphFragment = (
  hash: string,
): DecisionParagraphRange | null => {
  const encodedFragment = hash.startsWith("#") ? hash.slice(1) : hash;
  const fragment = Result.try(() =>
    decodeURIComponent(encodedFragment),
  ).unwrapOr(null);
  if (fragment === null) {
    return null;
  }
  if (!fragment.startsWith("par=")) {
    return null;
  }
  const parsed = parseDecisionParagraphRange(fragment.slice("par=".length));
  return Result.isError(parsed) ? null : parsed.value;
};
