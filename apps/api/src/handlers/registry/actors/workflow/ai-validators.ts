import { Result } from "better-result";

import type { Answer } from "@/api/handlers/registry/actors/workflow/ai-prompts";
import type { BatchProperty } from "@/api/handlers/registry/actors/workflow/get-execution-plan";
import {
  Unreachable,
  WorkflowValidationError,
} from "@/api/lib/errors/tagged-errors";

type TextValidatedResult = {
  type: "text";
  value: string;
  justificationXml: string;
};

type SingleSelectValidatedResult = {
  type: "single-select";
  value: string | null;
  justificationXml: string;
};

type MultiSelectValidatedResult = {
  type: "multi-select";
  value: string[];
  justificationXml: string;
};

type DateValidatedResult = {
  type: "date";
  value: string | null;
  justificationXml: string;
};

type IntValidatedResult = {
  type: "int";
  value: number;
  currency: string | null;
  justificationXml: string;
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
  justification: string;
}): ValidateResult => {
  if (typeof answer === "string") {
    return Result.ok({
      type: "text",
      value: answer,
      justificationXml: justification,
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
  justification: string;
  content: SelectContent;
}): ValidateResult => {
  if (answer === null && content.fallback !== null) {
    return Result.ok({
      type: "single-select",
      value: content.fallback,
      justificationXml: justification,
    });
  }

  if (typeof answer === "string" || answer === null) {
    return Result.ok({
      type: "single-select",
      value: answer,
      justificationXml: justification,
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
  justification: string;
  content: SelectContent;
}): ValidateResult => {
  if (answer === null) {
    return Result.ok({
      type: "multi-select",
      value: content.fallback !== null ? [content.fallback] : [],
      justificationXml: justification,
    });
  }

  if (isStringArray(answer)) {
    return Result.ok({
      type: "multi-select",
      value: [...new Set(answer)],
      justificationXml: justification,
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
  justification: string;
}): ValidateResult => {
  if (typeof answer === "string" || answer === null) {
    return Result.ok({
      type: "date",
      value: answer,
      justificationXml: justification,
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
  justification: string;
}): ValidateResult => {
  if (!Array.isArray(answer) && typeof answer === "object" && answer !== null) {
    return Result.ok({
      type: "int",
      value: answer.amount,
      currency: answer.currency,
      justificationXml: justification,
    });
  }

  return Result.err(
    new WorkflowValidationError({
      message: "Int answer is invalid",
    }),
  );
};

type ValidateAIOutputProps = {
  aiResult: { answer: Answer; justification: string };
  property: BatchProperty;
};

export const validateAIOutput = ({
  aiResult,
  property,
}: ValidateAIOutputProps): ValidateResult => {
  // oxlint-disable-next-line typescript/strict-boolean-expressions -- aiResult required param
  if (!aiResult) {
    return Result.err(
      new WorkflowValidationError({
        message: "AI response is missing",
      }),
    );
  }

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
