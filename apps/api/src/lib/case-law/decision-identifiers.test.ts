import { expect, test } from "bun:test";

import { DECISION_IDENTIFIER_TYPES } from "@stll/legal-ast/decision-identifier";

import { decisionIdentifierProjection } from "@/api/lib/case-law/decision-identifiers";

test("projects every persisted identifier", () => {
  expect(
    decisionIdentifierProjection(
      [
        {
          type: DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
          value: "[2024] Example Court 12",
        },
        {
          type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
          value: "12 Example Reports 34",
        },
      ],
      { caseNumber: "fallback", ecli: null },
    ),
  ).toEqual([
    {
      type: DECISION_IDENTIFIER_TYPES.NEUTRAL_CITATION,
      value: "[2024] Example Court 12",
    },
    {
      type: DECISION_IDENTIFIER_TYPES.REPORTER_CITATION,
      value: "12 Example Reports 34",
    },
  ]);
});

test("falls back to legacy columns until the bounded backfill reaches a row", () => {
  expect(
    decisionIdentifierProjection([], {
      caseNumber: "A-123",
      ecli: "ECLI:XX:COURT:2024:1",
    }),
  ).toEqual([
    { type: DECISION_IDENTIFIER_TYPES.CASE_NUMBER, value: "A-123" },
    {
      type: DECISION_IDENTIFIER_TYPES.ECLI,
      value: "ECLI:XX:COURT:2024:1",
    },
  ]);
});
