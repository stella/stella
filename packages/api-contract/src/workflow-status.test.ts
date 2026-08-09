import { describe, expect, test } from "bun:test";

import {
  isWorkObligationStatus,
  WORK_OBLIGATION_STATUS,
  WORK_OBLIGATION_STATUSES,
} from "./workflow-status";

describe("work-obligation statuses", () => {
  test("keeps the canonical status set ordered and immutable", () => {
    expect(WORK_OBLIGATION_STATUSES).toEqual([
      WORK_OBLIGATION_STATUS.UNASSIGNED,
      WORK_OBLIGATION_STATUS.AWAITING_ACKNOWLEDGEMENT,
      WORK_OBLIGATION_STATUS.ACTIVE,
      WORK_OBLIGATION_STATUS.COMPLETED,
      WORK_OBLIGATION_STATUS.CANCELLED,
    ]);
    expect(Object.isFrozen(WORK_OBLIGATION_STATUSES)).toBe(true);
  });

  test.each([
    ["unassigned", true],
    ["awaiting_acknowledgement", true],
    ["active", true],
    ["completed", true],
    ["cancelled", true],
    ["pending", false],
    [null, false],
    [undefined, false],
  ])("validates %p", (value, expected) => {
    expect(isWorkObligationStatus(value)).toBe(expected);
  });
});
