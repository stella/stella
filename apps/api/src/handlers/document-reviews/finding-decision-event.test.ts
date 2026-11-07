import { describe, expect, test } from "bun:test";

import { findingDecisionEvent } from "./finding-decision-event";

describe("finding decision events", () => {
  test.each([
    ["open", "accepted", "accepted"],
    ["accepted", "dismissed", "rejected"],
    ["dismissed", "open", null],
    ["accepted", "accepted", undefined],
  ] as const)("turns %s into %s", (previous, next, expected) => {
    expect(findingDecisionEvent(previous, next)).toBe(expected);
  });
});
