import { Result } from "better-result";

import type { FieldContent } from "@/api/db/schema-validators";
import {
  Unreachable,
  WorkflowValidationError,
} from "@/api/lib/errors/tagged-errors";
import type { Answer } from "@/api/lib/workflow/ai-prompts";
import type { BatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type { AIJustificationOutput } from "@/api/lib/workflow/parse-justifications";

type TextValidatedResult = {
  type: "text";
  value: string | null;
  justification: AIJustificationOutput;
};

type SingleSelectValidatedResult = {
  type: "single-select";
  value: string | null;
  justification: AIJustificationOutput;
};

type MultiSelectValidatedResult = {
  type: "multi-select";
  value: string[];
  justification: AIJustificationOutput;
};

type DateValidatedResult = {
  type: "date";
  value: string | null;
  justification: AIJustificationOutput;
};

type IntValidatedResult = {
  type: "int";
  value: number | null;
  currency: string | null;
  justification: AIJustificationOutput;
};

export type ValidatedResult =
  | TextValidatedResult
  | SingleSelectValidatedResult
  | MultiSelectValidatedResult
  | DateValidatedResult
  | IntValidatedResult;

type ValidateResult = Result<ValidatedResult, WorkflowValidationError>;

type SelectContent = Extract<
  BatchProperty["content"],
  { type: "single-select" | "multi-select" }
>;

const isStringArray = (value: Answer): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

const validateTextResult = ({
  answer,
  justification,
}: {
  answer: Answer;
  justification: AIJustificationOutput;
}): ValidateResult => {
  if (typeof answer === "string" || answer === null) {
    return Result.ok({
      type: "text",
      value: answer,
      justification,
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
  justification,
  content,
}: {
  answer: Answer;
  justification: AIJustificationOutput;
  content: SelectContent;
}): ValidateResult => {
  if (answer === null) {
    return Result.ok({
      type: "single-select",
      value: content.fallback,
      justification,
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
    justification,
  });
};

const validateMultiSelectResult = ({
  answer,
  justification,
  content,
}: {
  answer: Answer;
  justification: AIJustificationOutput;
  content: SelectContent;
}): ValidateResult => {
  if (answer === null) {
    return Result.ok({
      type: "multi-select",
      value: content.fallback !== null ? [content.fallback] : [],
      justification,
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
    justification,
  });
};

const validateDateResult = ({
  answer,
  justification,
}: {
  answer: Answer;
  justification: AIJustificationOutput;
}): ValidateResult => {
  if (typeof answer === "string" || answer === null) {
    return Result.ok({
      type: "date",
      value: answer,
      justification,
    });
  }

  return Result.err(
    new WorkflowValidationError({
      message: "Date answer is invalid",
    }),
  );
};

const validateIntResult = ({
  answer,
  justification,
}: {
  answer: Answer;
  justification: AIJustificationOutput;
}): ValidateResult => {
  if (answer === null) {
    return Result.ok({
      type: "int",
      value: null,
      currency: null,
      justification,
    });
  }

  if (!Array.isArray(answer) && typeof answer === "object") {
    return Result.ok({
      type: "int",
      value: answer.amount,
      currency: answer.currency,
      justification,
    });
  }

  return Result.err(
    new WorkflowValidationError({
      message: "Int answer is invalid",
    }),
  );
};

type ValidateAIOutputProps = {
  aiResult: { answer: Answer; justification: AIJustificationOutput };
  property: BatchProperty;
};

export const validateAIOutput = ({
  aiResult,
  property,
}: ValidateAIOutputProps): ValidateResult => {
  const { content } = property;
  const { answer, justification } = aiResult;

  switch (content.type) {
    case "text":
      return validateTextResult({ answer, justification });

    case "single-select":
      return validateSingleSelectResult({
        answer,
        justification,
        content,
      });

    case "multi-select":
      return validateMultiSelectResult({
        answer,
        justification,
        content,
      });

    case "date":
      return validateDateResult({ answer, justification });

    case "int":
      return validateIntResult({ answer, justification });

    // "money", "person" and "file" are not AI-extractable (see
    // isAiExtractablePropertyType): the execution plan never schedules them, so
    // reaching the default is a bug, not a missing branch.
    default:
      throw new Unreachable({
        message: "Property type not matched",
      });
  }
};

// The cell content a validated answer produces. Text and int intentionally
// have no "answered: absent" content variant yet, so a null value maps to
// `null` here rather than a fabricated placeholder; callers must leave the
// cell unwritten in that case instead of persisting it.
type ValidatedFieldContent = Extract<
  FieldContent,
  { type: "text" | "single-select" | "multi-select" | "date" | "int" }
>;

export const fieldContentFromValidated = (
  validated: ValidatedResult,
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
