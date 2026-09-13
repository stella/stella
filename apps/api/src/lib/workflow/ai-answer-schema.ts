import { panic } from "better-result";
import * as v from "valibot";

import type { AiExtractablePropertyContent } from "@/api/db/schema-validators";

/**
 * The structured output one column of any kind asks a model for, keyed by the
 * property content type.
 *
 * One registry, two callers: the workspace extractor batches these under
 * property ids (`buildBatchSchema`) and the case-law research runner batches
 * them under question-column ids. A kind added to the property model has to be
 * answered here once, not once per surface.
 */

/** `null` is an explicit "the source does not state this", valid for every kind. */
export type Answer =
  | string
  | string[]
  | null
  | { amount: number; currency: string | null };

type AnswerKind = AiExtractablePropertyContent["type"];

type SelectContent = Extract<
  AiExtractablePropertyContent,
  { type: "single-select" | "multi-select" }
>;

/**
 * What the model is told each kind expects. `description` is the schema-level
 * instruction; `hint` is the same expectation compressed to a phrase, for a
 * prompt that lists many questions inline. Both come from this one table so a
 * prompt cannot promise a shape the schema does not accept.
 */
const ANSWER_CONTEXT = {
  text: {
    description:
      "Answer for property. Keep it plain text, keep it " +
      "short and concise, less than 100 characters. Answer null if the " +
      "source does not state this value; never guess.",
    examples: ["Contract for sale of goods", null],
    hint: "short text",
  },
  "single-select": {
    description:
      "Answer for property. Select exactly one option from the list " +
      "below, or null if the source does not state this value or no " +
      "option applies; never guess.",
    examples: [null],
    hint: "exactly one option, or null when the text does not settle it",
  },
  "multi-select": {
    description:
      "Answer for property. Select one or more options from the list " +
      "below, or null if the source does not state this value or no " +
      "option applies; never guess.",
    examples: [null],
    hint: "one or more options, or null when none applies",
  },
  date: {
    description:
      "Answer in ISO YYYY-MM-DD format, " +
      "or null if no date is found in the document.",
    examples: ["2024-03-15", null],
    hint: "a date as ISO YYYY-MM-DD",
  },
  int: {
    description:
      "Answer for property, or null if the source does not state this " +
      "value; never guess.",
    examples: [null],
    hint: "a whole number, with its ISO currency code when it is an amount",
  },
} as const satisfies Record<
  AnswerKind,
  { description: string; examples: readonly unknown[]; hint: string }
>;

const INT_AMOUNT = {
  description: "The integer amount extracted from the document",
  examples: [1500],
} as const;

const INT_CURRENCY = {
  description:
    "ISO 4217 currency code if the value represents money, otherwise null",
  examples: ["USD", "EUR", "CZK"],
} as const;

const describeOptions = (content: SelectContent): string =>
  `Valid options: ${content.options.map((option) => option.value).join(", ")}.`;

/**
 * The answer schema for one column's content.
 *
 * Null for a select with no options: there is no answer the model could give,
 * so the caller drops the question rather than asking one against an empty
 * list.
 *
 * Select options are not enforced as a JSON Schema enum. A model deviation
 * would fail the parse for the whole batch object rather than for the one
 * column; the raw string passes through to `validateAnswerForContent`, which
 * checks membership and reports a column-scoped validation error instead.
 */
export const answerSchemaForContent = (
  content: AiExtractablePropertyContent,
): v.GenericSchema<Answer> | null => {
  switch (content.type) {
    case "text":
      return v.pipe(
        v.nullable(v.string()),
        v.description(ANSWER_CONTEXT.text.description),
        v.examples([...ANSWER_CONTEXT.text.examples]),
      );
    case "single-select":
      return content.options.length === 0
        ? null
        : v.pipe(
            v.nullable(v.string()),
            v.description(
              `${ANSWER_CONTEXT["single-select"].description} ${describeOptions(content)}`,
            ),
            v.examples([...ANSWER_CONTEXT["single-select"].examples]),
          );
    case "multi-select":
      return content.options.length === 0
        ? null
        : v.pipe(
            v.nullable(v.pipe(v.array(v.string()), v.nonEmpty())),
            v.description(
              `${ANSWER_CONTEXT["multi-select"].description} ${describeOptions(content)}`,
            ),
            v.examples([...ANSWER_CONTEXT["multi-select"].examples]),
          );
    case "date":
      return v.pipe(
        v.nullable(v.pipe(v.string(), v.isoDate())),
        v.description(ANSWER_CONTEXT.date.description),
        v.examples([...ANSWER_CONTEXT.date.examples]),
      );
    case "int":
      return v.pipe(
        v.nullable(
          v.strictObject({
            amount: v.pipe(
              v.number(),
              v.integer(),
              v.description(INT_AMOUNT.description),
              v.examples([...INT_AMOUNT.examples]),
            ),
            currency: v.pipe(
              v.nullable(v.string()),
              v.description(INT_CURRENCY.description),
              v.examples([...INT_CURRENCY.examples]),
            ),
          }),
        ),
        v.description(ANSWER_CONTEXT.int.description),
      );
    default: {
      content satisfies never;
      return panic(`Unhandled answer kind: ${String(content)}`);
    }
  }
};

/** The expected shape as one phrase, for a prompt that lists questions inline. */
export const answerShapeHint = (
  content: AiExtractablePropertyContent,
): string => {
  const { hint } = ANSWER_CONTEXT[content.type];
  return content.type === "single-select" || content.type === "multi-select"
    ? `${hint} — ${describeOptions(content)}`
    : hint;
};
