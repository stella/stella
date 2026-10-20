import { describe, expect, test } from "bun:test";

import {
  matchRepublishedRuling,
  REPUBLISHED_RULING_OUTCOME,
  REPUBLISHED_RULING_PARTIAL_REASON,
} from "./ruling-identity-match";

const complete = {
  country: "PL",
  courtId: "pl:nsa",
  caseNumber: "II OSK 123/24",
  decisionDate: "2024-06-03",
  decisionType: "wyrok",
} as const;

const stored = [{ decisionId: "canonical", identity: complete }];

describe("cross-source ruling identity", () => {
  test("links only one complete matching ruling", () => {
    expect(matchRepublishedRuling(complete, stored)).toEqual({
      type: REPUBLISHED_RULING_OUTCOME.LINKED,
      decisionId: "canonical",
    });
  });

  test("an absent date never links", () => {
    expect(
      matchRepublishedRuling({ ...complete, decisionDate: undefined }, stored),
    ).toEqual({
      type: REPUBLISHED_RULING_OUTCOME.SEPARATE_PARTIAL,
      reason: REPUBLISHED_RULING_PARTIAL_REASON.DATE_ABSENT,
    });
  });

  test("a different date stays separate", () => {
    expect(
      matchRepublishedRuling(
        { ...complete, decisionDate: "2024-06-04" },
        stored,
      ),
    ).toEqual({
      type: REPUBLISHED_RULING_OUTCOME.SEPARATE_PARTIAL,
      reason: REPUBLISHED_RULING_PARTIAL_REASON.DATE_DIFFERS,
    });
  });

  test("a different type stays separate", () => {
    expect(
      matchRepublishedRuling({ ...complete, decisionType: "uchwała" }, stored),
    ).toEqual({
      type: REPUBLISHED_RULING_OUTCOME.SEPARATE_PARTIAL,
      reason: REPUBLISHED_RULING_PARTIAL_REASON.TYPE_DIFFERS,
    });
  });

  test("multiple complete matches are ambiguous", () => {
    expect(
      matchRepublishedRuling(complete, [
        ...stored,
        { decisionId: "other", identity: complete },
      ]),
    ).toEqual({ type: REPUBLISHED_RULING_OUTCOME.SEPARATE_AMBIGUOUS });
  });
});
