import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { WorkflowValidationError } from "@/api/lib/errors/tagged-errors";
import {
  fieldContentFromValidated,
  isEmptyFieldContent,
  validateAIOutput,
} from "@/api/lib/workflow/ai-validators";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type { AIJustificationOutput } from "@/api/lib/workflow/parse-justifications";

const justification: AIJustificationOutput = [];

const aiModelTool = {
  version: 1 as const,
  type: "ai-model" as const,
  prompt: "test",
};

const textProperty: AIBatchProperty = {
  id: toSafeId<"property">("prop-text"),
  status: "stale",
  answerShape: "value",
  content: { version: 1, type: "text" },
  dependencies: [],
  tool: aiModelTool,
};

const intProperty: AIBatchProperty = {
  id: toSafeId<"property">("prop-int"),
  status: "stale",
  answerShape: "value",
  content: { version: 1, type: "int" },
  dependencies: [],
  tool: aiModelTool,
};

const selectPropertyWithFallback = (
  fallback: string | null,
): AIBatchProperty => ({
  id: toSafeId<"property">("prop-select"),
  status: "stale",
  answerShape: "value",
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

const multiSelectProperty: AIBatchProperty = {
  id: toSafeId<"property">("prop-multi"),
  status: "stale",
  answerShape: "value",
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
    expect(fieldContentFromValidated({ type: "text", value: null })).toBeNull();
    expect(
      fieldContentFromValidated({ type: "int", value: null, currency: null }),
    ).toBeNull();
  });

  test("a present text/int answer still maps to field content", () => {
    expect(fieldContentFromValidated({ type: "text", value: "Cash" })).toEqual({
      version: 1,
      type: "text",
      value: "Cash",
    });
    expect(
      fieldContentFromValidated({
        type: "int",
        value: 1500,
        currency: "USD",
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

const moneyProperty = (currency: string | null): AIBatchProperty => ({
  id: toSafeId<"property">("prop-money"),
  status: "stale",
  answerShape: "value",
  content: { version: 1, type: "money", currency },
  dependencies: [],
  tool: aiModelTool,
});

const validateMoney = (
  answer: { amount: number; currency: string | null } | null,
  currency: string | null,
) =>
  validateAIOutput({
    aiResult: { answer, justification },
    property: moneyProperty(currency),
  });

describe("validateAIOutput — money answers", () => {
  test("a stated amount becomes minor units of the stated currency", () => {
    const result = validateMoney(
      { amount: 1_250_000.5, currency: "czk" },
      "EUR",
    );
    expect(Result.isOk(result) && result.value).toMatchObject({
      type: "money",
      value: { amountCents: 125_000_050, currency: "CZK" },
    });
  });

  test("the scale follows the currency's minor unit, rounding half up", () => {
    const yen = validateMoney({ amount: 1500, currency: "JPY" }, null);
    expect(Result.isOk(yen) && yen.value).toMatchObject({
      value: { amountCents: 1500, currency: "JPY" },
    });
    const dinar = validateMoney({ amount: 12.5, currency: "KWD" }, null);
    expect(Result.isOk(dinar) && dinar.value).toMatchObject({
      value: { amountCents: 12_500, currency: "KWD" },
    });
    const halfUp = validateMoney({ amount: 1.005, currency: "USD" }, null);
    expect(Result.isOk(halfUp) && halfUp.value).toMatchObject({
      value: { amountCents: 101, currency: "USD" },
    });
  });

  test("an amount with no stated currency takes the column's default", () => {
    const result = validateMoney({ amount: -40, currency: null }, "EUR");
    expect(Result.isOk(result) && result.value).toMatchObject({
      value: { amountCents: -4000, currency: "EUR" },
    });
  });

  test("an amount with no currency anywhere is a column-scoped failure", () => {
    const result = validateMoney({ amount: 40, currency: null }, null);
    expect(Result.isError(result) && result.error).toBeInstanceOf(
      WorkflowValidationError,
    );
  });

  test("a currency that is not an ISO code is refused, not replaced by the default", () => {
    const result = validateMoney({ amount: 40, currency: "Kč" }, "CZK");
    expect(Result.isError(result)).toBe(true);
  });

  test("an amount outside the safe integer range is refused", () => {
    const result = validateMoney({ amount: 1e20, currency: "EUR" }, null);
    expect(Result.isError(result)).toBe(true);
  });

  test("an absent answer leaves the cell unwritten", () => {
    const result = validateMoney(null, "EUR");
    expect(Result.isOk(result) && result.value).toMatchObject({
      type: "money",
      value: null,
    });
    expect(
      fieldContentFromValidated({ type: "money", value: null }),
    ).toBeNull();
  });

  test("a validated amount is stored as money field content", () => {
    expect(
      fieldContentFromValidated({
        type: "money",
        value: { amountCents: 4000, currency: "EUR" },
      }),
    ).toEqual({
      version: 1,
      type: "money",
      amountCents: 4000,
      currency: "EUR",
    });
  });
});

describe("isEmptyFieldContent", () => {
  test("blank text, or an empty select, multi-select or date, states no value", () => {
    expect(isEmptyFieldContent({ version: 1, type: "text", value: "" })).toBe(
      true,
    );
    expect(
      isEmptyFieldContent({ version: 1, type: "text", value: " \n" }),
    ).toBe(true);
    expect(
      isEmptyFieldContent({ version: 1, type: "single-select", value: null }),
    ).toBe(true);
    expect(
      isEmptyFieldContent({ version: 1, type: "multi-select", value: [] }),
    ).toBe(true);
    expect(isEmptyFieldContent({ version: 1, type: "date", value: null })).toBe(
      true,
    );
  });

  test("a stated value is not empty", () => {
    expect(
      isEmptyFieldContent({ version: 1, type: "single-select", value: "Yes" }),
    ).toBe(false);
    expect(
      isEmptyFieldContent({ version: 1, type: "multi-select", value: ["A"] }),
    ).toBe(false);
    expect(
      isEmptyFieldContent({ version: 1, type: "date", value: "2026-11-08" }),
    ).toBe(false);
    expect(
      isEmptyFieldContent({ version: 1, type: "text", value: "Czech law" }),
    ).toBe(false);
  });
});
