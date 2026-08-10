import { describe, expect, test } from "bun:test";

import {
  getTimeEntryDateBounds,
  isTimeEntryDateAllowed,
} from "./time-entry-date.logic";

describe("manual time-entry date window", () => {
  test("accepts both boundaries and rejects dates outside them", () => {
    const bounds = getTimeEntryDateBounds("2026-08-10");

    expect(bounds).toEqual({
      earliestDate: "2026-05-12",
      today: "2026-08-10",
    });
    expect(isTimeEntryDateAllowed("2026-05-12", bounds)).toBe(true);
    expect(isTimeEntryDateAllowed("2026-08-10", bounds)).toBe(true);
    expect(isTimeEntryDateAllowed("2026-05-11", bounds)).toBe(false);
    expect(isTimeEntryDateAllowed("2026-08-11", bounds)).toBe(false);
  });
});
