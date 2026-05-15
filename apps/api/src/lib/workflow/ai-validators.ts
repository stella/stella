import { Result } from "better-result";

import {
  Unreachable,
  WorkflowValidationError,
} from "@/api/lib/errors/tagged-errors";
import type { Answer } from "@/api/lib/workflow/ai-prompts";
import type { BatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type { AIJustificationOutput } from "@/api/lib/workflow/parse-justifications";

type TextValidatedResult = {
  type: "text";
  value: string;
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
  value: number;
  currency: string | null;
  justification: AIJustificationOutput;
};

type ValidatedResult =
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
  if (typeof answer === "string") {
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
  if (answer === null && content.fallback !== null) {
    return Result.ok({
      type: "single-select",
      value: content.fallback,
      justification,
    });
  }

  if (typeof answer === "string" || answer === null) {
    return Result.ok({
      type: "single-select",
      value: answer,
      justification,
    });
  }

  return Result.err(
    new WorkflowValidationError({
      message: "Single select answer is invalid",
    }),
  );
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

  if (isStringArray(answer)) {
    return Result.ok({
      type: "multi-select",
      value: [...new Set(answer)],
      justification,
    });
  }

  return Result.err(
    new WorkflowValidationError({
      message: "Multi select answer is invalid",
    }),
  );
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
  if (!Array.isArray(answer) && typeof answer === "object" && answer !== null) {
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

    default:
      throw new Unreachable({
        message: "Property type not matched",
      });
  }
};
