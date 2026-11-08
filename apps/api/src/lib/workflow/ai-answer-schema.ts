import { panic } from "better-result";
import * as v from "valibot";

import { apiDateSchema } from "@stll/api-contract/api-date";

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

/**
 * `null` is an explicit "the source does not state this", valid for every kind.
 * An amount is an integer for an `int` column and a major-unit decimal for a
 * `money` column; the column's content says which, so the shape is shared.
 */
export type Answer =
  string | string[] | null | { amount: number; currency: string | null };

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
      "short and concise, less than 100 characters, unless the prompt asks " +
      "for the source's wording to be quoted: then quote that wording " +
      "verbatim and in full, at whatever length it takes, and add no " +
      "commentary of your own. Answer null if the source does not state " +
      "this value; never guess.",
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
  money: {
    description:
      "Monetary amount for property, or null if the source does not state " +
      "this amount; never guess and never convert between currencies.",
    examples: [null],
    hint: "a money amount in major units with its ISO currency code",
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

const MONEY_AMOUNT = {
  description:
    "The amount in major units exactly as the source states it, as a plain " +
    "number: 1250000.5 for 1 250 000,50. Keep the sign of a negative amount.",
  examples: [1_250_000.5],
} as const;

const moneyCurrencyDescription = (defaultCurrency: string | null): string =>
  defaultCurrency === null
    ? "ISO 4217 code of the currency the source states the amount in"
    : "ISO 4217 code of the currency the source states the amount in, or " +
      `null when the source states none (${defaultCurrency} then applies)`;

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
        v.nullable(apiDateSchema),
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
    case "money":
      return v.pipe(
        v.nullable(
          v.strictObject({
            amount: v.pipe(
              v.number(),
              v.description(MONEY_AMOUNT.description),
              v.examples([...MONEY_AMOUNT.examples]),
            ),
            currency: v.pipe(
              v.nullable(v.string()),
              v.description(moneyCurrencyDescription(content.currency)),
              v.examples([...INT_CURRENCY.examples]),
            ),
          }),
        ),
        v.description(ANSWER_CONTEXT.money.description),
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
