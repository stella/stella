import { describe, expect, test } from "bun:test";
import { createFormatter } from "use-intl/core";

import type {
  ConditionDecision,
  DecidedCondition,
} from "@/components/templates/template-ai-conditions.logic";
import {
  activeConditionDecisions,
  conditionChipState,
  conditionRequestValues,
  cycleConditionOverride,
  describeConditionChip,
  effectiveConditionValues,
  formatProbability,
  hasEnteredValues,
  isAiDecidedCondition,
  readConditionOverrides,
} from "@/components/templates/template-ai-conditions.logic";
import type { ResolvedField } from "@/components/templates/template-discover-types";

const field = (overrides: Partial<ResolvedField>): ResolvedField => ({
  path: "hasGuarantor",
  kind: "boolean",
  inputType: "boolean",
  count: 0,
  ...overrides,
});

const decided = (value: boolean, probability: number): ConditionDecision => ({
  state: "decided",
  decidedBy: "decision_model",
  value,
  probability,
  confidence: probability,
});

const condition = (
  path: string,
  decision: ConditionDecision,
): DecidedCondition => ({ path, label: path, decision });

describe("isAiDecidedCondition", () => {
  test("a boolean field with an aiPrompt is decided by the model", () => {
    expect(
      isAiDecidedCondition(field({ aiPrompt: "Is there a guarantor?" })),
    ).toBe(true);
  });

  test("the input type, not the value kind, defines a boolean condition", () => {
    expect(
      isAiDecidedCondition(
        field({ kind: "string", inputType: "boolean", aiPrompt: "?" }),
      ),
    ).toBe(true);
    expect(
      isAiDecidedCondition(
        field({ inputType: "text", aiPrompt: "Is there a guarantor?" }),
      ),
    ).toBe(false);
  });

  test("a boolean the user answers is not", () => {
    expect(isAiDecidedCondition(field({}))).toBe(false);
  });

  test("an AI-drafted text field is not a condition", () => {
    expect(
      isAiDecidedCondition(
        field({ kind: "string", inputType: "text", aiPrompt: "Draft it" }),
      ),
    ).toBe(false);
  });

  test("an empty prompt is not a question for the decision model", () => {
    expect(isAiDecidedCondition(field({ aiPrompt: "" }))).toBe(false);
  });
});

describe("chip state", () => {
  test("no answer yet still reads as the model's to decide", () => {
    expect(conditionChipState(undefined, undefined)).toEqual({
      kind: "model",
      decision: null,
    });
  });

  test("an answer with no override shows the model's decision", () => {
    const decision = decided(true, 0.96);
    expect(conditionChipState(undefined, decision)).toEqual({
      kind: "model",
      decision,
    });
  });

  test.each([true, false])(
    "a forced %s outranks the model's answer",
    (value) => {
      expect(conditionChipState(value, decided(!value, 0.99))).toEqual({
        kind: "forced",
        value,
      });
    },
  );

  test("a non-boolean leftover in the form values is not an override", () => {
    expect(conditionChipState("", undefined)).toEqual({
      kind: "model",
      decision: null,
    });
  });
});

describe("cycleConditionOverride", () => {
  test("cycles model → yes → no → model", () => {
    const first = cycleConditionOverride(undefined);
    expect(first).toBe(true);
    const second = cycleConditionOverride(first);
    expect(second).toBe(false);
    expect(cycleConditionOverride(second)).toBeUndefined();
  });

  test("returns to the model after three clicks, whatever it started as", () => {
    for (const start of [undefined, true, false]) {
      const cycled = cycleConditionOverride(
        cycleConditionOverride(cycleConditionOverride(start)),
      );
      expect(cycled).toBe(start);
    }
  });
});

describe("conditionRequestValues", () => {
  const paths = ["hasGuarantor", "isLongTerm"];
  const visibleFields = [
    field({ path: "landlord.name", kind: "string", inputType: "text" }),
    field({ path: "rent", kind: "string", inputType: "number" }),
    field({ path: "parties", kind: "array", inputType: undefined }),
  ];
  const visibleArrayIndexPaths = ["__array_parties"];

  test("keeps visible values and drops conditions, hidden values, and cleared values", () => {
    expect(
      conditionRequestValues({
        values: {
          "landlord.name": "Nowak",
          rent: "1200",
          hiddenNote: "must not reach the model",
          hasGuarantor: true,
          isLongTerm: undefined,
          note: undefined,
        },
        conditionPaths: paths,
        visibleArrayIndexPaths,
        visibleFields,
      }),
    ).toEqual({ "landlord.name": "Nowak", rent: "1200" });
  });

  test("a cleared override and an absent key produce the same request", () => {
    expect(
      conditionRequestValues({
        values: { rent: "1200", hasGuarantor: undefined },
        conditionPaths: paths,
        visibleArrayIndexPaths,
        visibleFields,
      }),
    ).toEqual(
      conditionRequestValues({
        values: { rent: "1200" },
        conditionPaths: paths,
        visibleArrayIndexPaths,
        visibleFields,
      }),
    );
  });

  test("keeps the index and item values of a visible array", () => {
    expect(
      conditionRequestValues({
        values: {
          __array_parties: [0],
          "parties[0].name": "Nowak",
          "hiddenParties[0].name": "Smith",
        },
        conditionPaths: paths,
        visibleArrayIndexPaths,
        visibleFields,
      }),
    ).toEqual({
      __array_parties: [0],
      "parties[0].name": "Nowak",
    });
  });
});

describe("hasEnteredValues", () => {
  test.each([
    [{}, false],
    [{ rent: "" }, false],
    [{ rent: "   " }, false],
    [{ signed: false }, true],
    [{ __array_parties: [] }, false],
    [{ rent: "1200" }, true],
    [{ signed: true }, true],
    [{ term: 12 }, true],
    [{ __array_parties: [0] }, true],
  ])("%o → %s", (values, expected) => {
    expect(hasEnteredValues(values)).toBe(expected);
  });
});

describe("activeConditionDecisions", () => {
  const previous = [condition("hasGuarantor", decided(true, 0.96))];

  test("drops retained query data after the last entered value is cleared", () => {
    expect(activeConditionDecisions({ rent: "" }, previous)).toEqual([]);
  });

  test("keeps the current decisions while the request has an entered value", () => {
    expect(activeConditionDecisions({ rent: "1200" }, previous)).toBe(previous);
  });
});

describe("effectiveConditionValues", () => {
  test("keeps settled answers and drops the ones the fill still decides", () => {
    expect(
      effectiveConditionValues(
        [
          condition("hasGuarantor", decided(true, 0.96)),
          condition("isLongTerm", {
            state: "undecided",
            reason: "below-floor",
          }),
        ],
        {},
      ),
    ).toEqual({ hasGuarantor: true });
  });

  test("an override wins over the model's answer", () => {
    expect(
      effectiveConditionValues(
        [condition("hasGuarantor", decided(true, 0.96))],
        {
          hasGuarantor: false,
        },
      ),
    ).toEqual({ hasGuarantor: false });
  });

  test("an override survives a condition the model could not answer", () => {
    expect(
      effectiveConditionValues(
        [condition("isLongTerm", { state: "undecided", reason: "failed" })],
        { isLongTerm: true },
      ),
    ).toEqual({ isLongTerm: true });
  });
});

describe("readConditionOverrides", () => {
  const paths = ["hasGuarantor", "isLongTerm"];

  test("reads only booleans sitting under a condition path", () => {
    expect(
      readConditionOverrides(
        {
          hasGuarantor: false,
          isLongTerm: undefined,
          rent: "1200",
          signed: true,
        },
        paths,
      ),
    ).toEqual({ hasGuarantor: false });
  });

  test("a full cycle leaves no override behind", () => {
    let value: unknown;
    for (let click = 0; click < 3; click++) {
      value = cycleConditionOverride(value);
    }
    expect(readConditionOverrides({ hasGuarantor: value }, paths)).toEqual({});
  });
});

describe("describeConditionChip", () => {
  test("a failed preview is an explicit destructive state", () => {
    expect(describeConditionChip({ kind: "error" })).toEqual({
      tone: "destructive",
      answer: { kind: "error" },
    });
  });

  test("a model answer carries the probability it is stated with", () => {
    expect(
      describeConditionChip({ kind: "model", decision: decided(true, 0.96) }),
    ).toEqual({
      tone: "success",
      answer: { kind: "decided", value: true, probability: 0.96 },
    });
  });

  test("a value the user set never shows a probability", () => {
    expect(describeConditionChip({ kind: "forced", value: false })).toEqual({
      tone: "highlight",
      answer: { kind: "forced", value: false },
    });
  });

  test("a user value reported by the backend stays a forced answer", () => {
    expect(
      describeConditionChip({
        kind: "model",
        decision: { state: "decided", decidedBy: "user", value: false },
      }),
    ).toEqual({
      tone: "highlight",
      answer: { kind: "forced", value: false },
    });
  });

  test("no answer yet reads the same as no backend", () => {
    expect(describeConditionChip({ kind: "model", decision: null })).toEqual(
      describeConditionChip({
        kind: "model",
        decision: { state: "undecided", reason: "no-backend" },
      }),
    );
  });

  test("only below-floor warns; the others are plain", () => {
    const tone = (reason: "below-floor" | "no-backend" | "failed") =>
      describeConditionChip({
        kind: "model",
        decision: { state: "undecided", reason },
      }).tone;
    expect(tone("below-floor")).toBe("warning");
    expect(tone("no-backend")).toBe("neutral");
    expect(tone("failed")).toBe("neutral");
  });
});

describe("formatProbability", () => {
  const percent = (locale: string) => {
    const format = createFormatter({ locale });
    return (probability: number) =>
      formatProbability(probability, (value, options) =>
        format.number(value, options),
      );
  };

  test("rounds to whole percent", () => {
    expect(percent("en")(0.962)).toBe("96%");
  });

  test("follows the locale's percent spacing and digits", () => {
    // Czech separates the sign with a non-breaking space; Egyptian Arabic
    // renders Eastern Arabic-Indic digits and its own percent sign. Neither
    // survives a hand-built `${value}%`.
    expect(percent("cs")(0.962)).toBe("96 %");
    expect(percent("ar-EG")(0.962)).toBe("٩٦٪؜");
  });

  test("clamps a probability outside [0, 1]", () => {
    expect(percent("en")(1.4)).toBe("100%");
    expect(percent("en")(-0.2)).toBe("0%");
  });
});
