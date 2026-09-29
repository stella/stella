import { describe, expect, test } from "bun:test";

import {
  isEligibleLegislationExpression,
  LEGISLATION_EXPRESSION_KINDS,
  LEGISLATION_WINDOW_DISPOSITIONS,
} from "@stll/api-contract/legislation-expression";

import {
  ineligibleExpressionLabelKey,
  readExpressionEligibility,
} from "@/features/statutes/statute-expression";
import messages from "@/i18n/langs/en.json";

const EVERY_EXPRESSION = LEGISLATION_EXPRESSION_KINDS.flatMap(
  (expressionKind) =>
    LEGISLATION_WINDOW_DISPOSITIONS.map((windowDisposition) => ({
      expressionKind,
      windowDisposition,
    })),
);

/** The English text a dotted message key names, or undefined. */
const messageAt = (key: string): unknown => {
  let node: unknown = messages;
  for (const segment of key.split(".")) {
    node =
      typeof node === "object" && node !== null
        ? Reflect.get(node, segment)
        : undefined;
  }
  return node;
};

describe("the label a version that cannot apply carries", () => {
  test("every version the API never answers with is labelled, and no other", () => {
    for (const expression of EVERY_EXPRESSION) {
      const label = ineligibleExpressionLabelKey(expression);
      expect({ expression, labelled: label !== null }).toEqual({
        expression,
        labelled: !isEligibleLegislationExpression(expression),
      });
      if (label !== null) {
        expect(typeof messageAt(label)).toBe("string");
      }
    }
  });

  test("a promulgated text is named as one, whatever its window", () => {
    expect(
      ineligibleExpressionLabelKey({
        expressionKind: "promulgated",
        windowDisposition: "effective",
      }),
    ).toBe("statutes.expression.promulgated");
  });
});

describe("reading the eligibility fields off untyped data", () => {
  test("reads known values and refuses anything else", () => {
    expect(readExpressionEligibility("consolidation", "effective")).toEqual({
      expressionKind: "consolidation",
      windowDisposition: "effective",
    });
    expect(readExpressionEligibility(null, "effective")).toBeNull();
    expect(readExpressionEligibility("consolidation", "retired")).toBeNull();
  });
});
