import { Result } from "better-result";

import type {
  AiExtractablePropertyContent,
  FieldContent,
} from "@/api/db/schema-validators";
import {
  Unreachable,
  WorkflowValidationError,
} from "@/api/lib/errors/tagged-errors";
import type { Answer } from "@/api/lib/workflow/ai-answer-schema";
import type { BatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type { AIJustificationOutput } from "@/api/lib/workflow/parse-justifications";

/**
 * A model answer checked against the column's content: options resolved and
 * absence normalized to the kind's own empty value. It carries no provenance,
 * so the case-law research runner (which cites decision passages rather than
 * file blocks) validates through the same registry the extractor does.
 */
export type ValidatedAnswer =
  | { type: "text"; value: string | null }
  | { type: "single-select"; value: string | null }
  | { type: "multi-select"; value: string[] }
  | { type: "date"; value: string | null }
  | { type: "int"; value: number | null; currency: string | null };

export type ValidatedResult = ValidatedAnswer & {
  justification: AIJustificationOutput;
};

type ValidateResult = Result<ValidatedAnswer, WorkflowValidationError>;

type SelectContent = Extract<
  AiExtractablePropertyContent,
  { type: "single-select" | "multi-select" }
>;

const isStringArray = (value: Answer): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

const validateTextResult = (answer: Answer): ValidateResult => {
  if (typeof answer === "string" || answer === null) {
    return Result.ok({
      type: "text",
      value: answer,
    });
  }

  return Result.err(
    new WorkflowValidationError({
      message: "Text answer is invalid",
    }),
  );
};

const validateSingleSelectResult = ({
  answer,
  content,
}: {
  answer: Answer;
  content: SelectContent;
}): ValidateResult => {
  if (answer === null) {
    return Result.ok({
      type: "single-select",
      value: content.fallback,
    });
  }

  if (typeof answer !== "string") {
    return Result.err(
      new WorkflowValidationError({
        message: "Single select answer is invalid",
      }),
    );
  }

  const isConfiguredOption = content.options.some(
    (option) => option.value === answer,
  );
  if (!isConfiguredOption) {
    return Result.err(
      new WorkflowValidationError({
        message: `Single select answer "${answer}" is not one of the configured options`,
      }),
    );
  }

  return Result.ok({
    type: "single-select",
    value: answer,
  });
};

const validateMultiSelectResult = ({
  answer,
  content,
}: {
  answer: Answer;
  content: SelectContent;
}): ValidateResult => {
  if (answer === null) {
    return Result.ok({
      type: "multi-select",
      value: content.fallback !== null ? [content.fallback] : [],
    });
  }

  if (!isStringArray(answer)) {
    return Result.err(
      new WorkflowValidationError({
        message: "Multi select answer is invalid",
      }),
    );
  }

  const configuredValues = new Set(
    content.options.map((option) => option.value),
  );
  const invalidValues = answer.filter((value) => !configuredValues.has(value));
  if (invalidValues.length > 0) {
    return Result.err(
      new WorkflowValidationError({
        message: `Multi select answer contains options not in the configured list: ${invalidValues.join(", ")}`,
      }),
    );
  }

  return Result.ok({
    type: "multi-select",
    value: [...new Set(answer)],
  });
};

const validateDateResult = (answer: Answer): ValidateResult => {
  if (typeof answer === "string" || answer === null) {
    return Result.ok({
      type: "date",
      value: answer,
    });
  }

  return Result.err(
    new WorkflowValidationError({
      message: "Date answer is invalid",
    }),
  );
};

const validateIntResult = (answer: Answer): ValidateResult => {
  if (answer === null) {
    return Result.ok({
      type: "int",
      value: null,
      currency: null,
    });
  }

  if (!Array.isArray(answer) && typeof answer === "object") {
    return Result.ok({
      type: "int",
      value: answer.amount,
      currency: answer.currency,
    });
  }

  return Result.err(
    new WorkflowValidationError({
      message: "Int answer is invalid",
    }),
  );
};

type ValidateAnswerProps = {
  answer: Answer;
  content: AiExtractablePropertyContent;
};

/** One model answer against one column's content, whatever asked the question. */
export const validateAnswerForContent = ({
  answer,
  content,
}: ValidateAnswerProps): ValidateResult => {
  switch (content.type) {
    case "text":
      return validateTextResult(answer);

    case "single-select":
      return validateSingleSelectResult({ answer, content });

    case "multi-select":
      return validateMultiSelectResult({ answer, content });

    case "date":
      return validateDateResult(answer);

    case "int":
      return validateIntResult(answer);

    // "money", "person" and "file" are not AI-extractable (see
    // isAiExtractablePropertyContent): they are outside this union, so the
    // default is a bug rather than a missing branch.
    default:
      content satisfies never;
      throw new Unreachable({
        message: "Property type not matched",
      });
  }
};

type ValidateAIOutputProps = {
  aiResult: { answer: Answer; justification: AIJustificationOutput };
  property: BatchProperty;
};

export const validateAIOutput = ({
  aiResult,
  property,
}: ValidateAIOutputProps): Result<ValidatedResult, WorkflowValidationError> =>
  Result.map(
    validateAnswerForContent({
      answer: aiResult.answer,
      content: property.content,
    }),
    (validated) => ({ ...validated, justification: aiResult.justification }),
  );

// The cell content a validated answer produces. Text and int intentionally
// have no "answered: absent" content variant yet, so a null value maps to
// `null` here rather than a fabricated placeholder; callers must leave the
// cell unwritten in that case instead of persisting it.
type ValidatedFieldContent = Extract<
  FieldContent,
  { type: "text" | "single-select" | "multi-select" | "date" | "int" }
>;

export const fieldContentFromValidated = (
  validated: ValidatedAnswer,
): ValidatedFieldContent | null => {
  switch (validated.type) {
    case "text":
      return validated.value === null
        ? null
        : { version: 1, type: "text", value: validated.value };
    case "single-select":
      return { version: 1, type: "single-select", value: validated.value };
    case "multi-select":
      return { version: 1, type: "multi-select", value: validated.value };
    case "date":
      return { version: 1, type: "date", value: validated.value };
    case "int":
      return validated.value === null
        ? null
        : {
            version: 1,
            type: "int",
            value: validated.value,
            currency: validated.currency,
          };
    default: {
      validated satisfies never;
      throw new Unreachable({
        message: "Validated result type not matched",
      });
    }
  }
};
