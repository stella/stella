import { Result, TaggedError } from "better-result";
import * as v from "valibot";

/** An inclusive range of court-assigned paragraph numbers. */
export type DecisionParagraphRange = {
  readonly from: number;
  readonly to: number;
};

const MAX_DECISION_PARAGRAPH_RANGE_SPAN = 500;
const MAX_DECISION_PARAGRAPH_RANGE_INPUT_CHARS = 33;
const PARAGRAPH_RANGE_PATTERN = /^(?<from>\d+)(?:[-–](?<to>\d+))?$/u;

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
  if (input.length > MAX_DECISION_PARAGRAPH_RANGE_INPUT_CHARS) {
    return null;
  }
  const groups = PARAGRAPH_RANGE_PATTERN.exec(input)?.groups;
  const fromText = groups?.["from"];
  const toText = groups?.["to"];
  if (fromText === undefined) {
    return null;
  }

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

/** A Valibot wire schema whose advertised input stays a string. */
export const decisionParagraphRangeSchema: v.GenericSchema<
  string,
  DecisionParagraphRange
> = v.pipe(
  v.string(),
  v.maxLength(MAX_DECISION_PARAGRAPH_RANGE_INPUT_CHARS),
  v.check(
    (input) => parseErrorReasonOf(input) !== "garbage",
    "Expected a positive safe paragraph number or range",
  ),
  v.regex(PARAGRAPH_RANGE_PATTERN),
  v.check(
    (input) => parseErrorReasonOf(input) !== "reversed",
    "Paragraph range ends before it starts",
  ),
  v.check(
    (input) => parseErrorReasonOf(input) !== "too-wide",
    "Paragraph range may span at most 500 numbers",
  ),
  v.transform((input) => {
    const [fromText, toText] = input.split(/[-–]/u);
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
  const fragment = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!fragment.startsWith("par=")) {
    return null;
  }
  const parsed = parseDecisionParagraphRange(fragment.slice("par=".length));
  return Result.isError(parsed) ? null : parsed.value;
};
