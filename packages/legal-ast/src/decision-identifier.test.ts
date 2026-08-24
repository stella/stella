import { describe, expect, test } from "bun:test";

import {
  DECISION_IDENTIFIER_MAX_LENGTH,
  DECISION_IDENTIFIER_TYPES,
  isDecisionIdentifier,
  normalizeStructuredDecisionIdentifier,
} from "./decision-identifier";
import type { DecisionIdentifiers } from "./decision-identifier";

describe("decision identifiers", () => {
  test.each(Object.values(DECISION_IDENTIFIER_TYPES))("accepts %s", (type) => {
    expect(isDecisionIdentifier({ type, value: "published identifier" })).toBe(
      true,
    );
  });

  test("rejects blank identifier values", () => {
    expect(
      isDecisionIdentifier({
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: " \n ",
      }),
    ).toBe(false);
  });

  test.each(["\u0000", "\u200B", " \uFEFF\u2060\n"])(
    "rejects invisible-only identifier value %j",
    (value) => {
      expect(
        isDecisionIdentifier({
          type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
          value,
        }),
      ).toBe(false);
    },
  );

  test("rejects fields from a different identifier shape", () => {
    expect(
      isDecisionIdentifier({
        type: DECISION_IDENTIFIER_TYPES.ECLI,
        value: "ECLI:XX:COURT:2026:1",
        reporter: "Example Reports",
      }),
    ).toBe(false);
  });

  test("rejects values beyond the shared storage boundary", () => {
    expect(
      isDecisionIdentifier({
        type: DECISION_IDENTIFIER_TYPES.ECLI,
        value: "x".repeat(DECISION_IDENTIFIER_MAX_LENGTH + 1),
      }),
    ).toBe(false);
  });

  test.each([
    [DECISION_IDENTIFIER_TYPES.ECLI, "ECLI:EU:C:2024:123", "euc2024123"],
    [
      DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
      "[2024] Example Court 12",
      "2024examplecourt12",
    ],
    [DECISION_IDENTIFIER_TYPES.REPORTER_CITATION, "347 U.S. 483", "347us483"],
  ] as const)(
    "normalizes structured identifier %s",
    (type, value, expected) => {
      expect(
        normalizeStructuredDecisionIdentifier({
          type,
          value,
        }),
      ).toBe(expected);
    },
  );

  test("represents parallel citations as identifiers for one decision", () => {
    const identifiers = [
      {
        type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER,
        value: "A-123",
      },
      {
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "12 Example Reports 34",
      },
      {
        type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
        value: "56 Parallel Reports 78",
      },
    ] as const satisfies DecisionIdentifiers;

    expect(identifiers).toHaveLength(3);
  });
});
