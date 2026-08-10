import { describe, expect, test } from "bun:test";

import {
  combineDurationParts,
  parseDurationPart,
  splitDurationMinutes,
} from "@/routes/_protected.workspaces/$workspaceId/-components/billing/duration-input.logic";

describe("duration parts", () => {
  test.each([
    [0, { hours: 0, minutes: 0 }],
    [7, { hours: 0, minutes: 7 }],
    [67, { hours: 1, minutes: 7 }],
    [120, { hours: 2, minutes: 0 }],
  ])("splits %i exact minutes into explicit units", (value, expected) => {
    expect(splitDurationMinutes(value)).toEqual(expected);
  });

  test("combines explicit units into exact minutes", () => {
    expect(combineDurationParts({ hours: 2, minutes: 15 })).toBe(135);
  });

  test.each([
    ["", 0],
    ["2", 2],
    ["1.1", null],
    ["-1", null],
    ["time", null],
  ])("parses only whole non-negative unit values for %s", (value, expected) => {
    expect(parseDurationPart(value)).toBe(expected);
  });
});
