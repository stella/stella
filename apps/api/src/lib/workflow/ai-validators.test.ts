import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { WorkflowValidationError } from "@/api/lib/errors/tagged-errors";
import {
  fieldContentFromValidated,
  validateAIOutput,
} from "@/api/lib/workflow/ai-validators";
import type { BatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type { AIJustificationOutput } from "@/api/lib/workflow/parse-justifications";

const justification: AIJustificationOutput = [];

const aiModelTool = {
  version: 1 as const,
  type: "ai-model" as const,
  prompt: "test",
};

const textProperty: BatchProperty = {
  id: toSafeId<"property">("prop-text"),
  status: "stale",
  content: { version: 1, type: "text" },
  dependencies: [],
  tool: aiModelTool,
};

const intProperty: BatchProperty = {
  id: toSafeId<"property">("prop-int"),
  status: "stale",
  content: { version: 1, type: "int" },
  dependencies: [],
  tool: aiModelTool,
};

const selectPropertyWithFallback = (
  fallback: string | null,
): BatchProperty => ({
  id: toSafeId<"property">("prop-select"),
  status: "stale",
  content: {
    version: 1,
    type: "single-select",
    options: [
      { color: "red", value: "Yes" },
      { color: "green", value: "No" },
    ],
    fallback,
  },
  dependencies: [],
  tool: aiModelTool,
});

const multiSelectProperty: BatchProperty = {
  id: toSafeId<"property">("prop-multi"),
  status: "stale",
  content: {
    version: 1,
    type: "multi-select",
    options: [
      { color: "red", value: "A" },
      { color: "green", value: "B" },
    ],
    fallback: null,
  },
  dependencies: [],
  tool: aiModelTool,
};

describe("validateAIOutput — absent answers", () => {
  test("a null text answer validates as absent, not a fabricated string", () => {
    const result = validateAIOutput({
      aiResult: { answer: null, justification },
      property: textProperty,
    }).unwrap();

    expect(result).toEqual({ type: "text", value: null, justification });
  });

  test("a null int answer validates as absent, not a fabricated amount", () => {
    const result = validateAIOutput({
      aiResult: { answer: null, justification },
      property: intProperty,
    }).unwrap();

    expect(result).toEqual({
      type: "int",
      value: null,
      currency: null,
      justification,
    });
  });

  test("an absent text/int answer maps to no field content to persist", () => {
    expect(
      fieldContentFromValidated({
        type: "text",
        value: null,
        justification,
      }),
    ).toBeNull();
    expect(
      fieldContentFromValidated({
        type: "int",
        value: null,
        currency: null,
        justification,
      }),
    ).toBeNull();
  });

  test("a present text/int answer still maps to field content", () => {
    expect(
      fieldContentFromValidated({
        type: "text",
        value: "Cash",
        justification,
      }),
    ).toEqual({ version: 1, type: "text", value: "Cash" });
    expect(
      fieldContentFromValidated({
        type: "int",
        value: 1500,
        currency: "USD",
        justification,
      }),
    ).toEqual({ version: 1, type: "int", value: 1500, currency: "USD" });
  });
});

describe("validateAIOutput — select answers", () => {
  test("an out-of-picklist single-select answer is a visible validation error, not null", () => {
    const result = validateAIOutput({
      aiResult: { answer: "Maybe", justification },
      property: selectPropertyWithFallback(null),
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(WorkflowValidationError);
    }
  });

  test("a valid single-select answer passes through", () => {
    const result = validateAIOutput({
      aiResult: { answer: "Yes", justification },
      property: selectPropertyWithFallback(null),
    }).unwrap();

    expect(result).toEqual({
      type: "single-select",
      value: "Yes",
      justification,
    });
  });

  test("a null single-select answer applies the configured fallback", () => {
    const result = validateAIOutput({
      aiResult: { answer: null, justification },
      property: selectPropertyWithFallback("No"),
    }).unwrap();

    expect(result).toEqual({
      type: "single-select",
      value: "No",
      justification,
    });
  });

  test("a null single-select answer with no fallback stays absent", () => {
    const result = validateAIOutput({
      aiResult: { answer: null, justification },
      property: selectPropertyWithFallback(null),
    }).unwrap();

    expect(result).toEqual({
      type: "single-select",
      value: null,
      justification,
    });
  });

  test("a multi-select answer containing an out-of-picklist option is a visible validation error", () => {
    const result = validateAIOutput({
      aiResult: { answer: ["A", "Z"], justification },
      property: multiSelectProperty,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toBeInstanceOf(WorkflowValidationError);
    }
  });

  test("a valid multi-select answer passes through deduplicated", () => {
    const result = validateAIOutput({
      aiResult: { answer: ["A", "A", "B"], justification },
      property: multiSelectProperty,
    }).unwrap();

    expect(result).toEqual({
      type: "multi-select",
      value: ["A", "B"],
      justification,
    });
  });
});
