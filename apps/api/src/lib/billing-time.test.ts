import { describe, expect, test } from "bun:test";

import { getTimeEntryDateValidationError } from "./billing-time";

describe("getTimeEntryDateValidationError", () => {
  test("keeps both ends of the 90-day window inclusive across a leap day", () => {
    expect(
      getTimeEntryDateValidationError({
        dateWorked: "2023-12-02",
        today: "2024-03-01",
      }),
    ).toBeNull();
    expect(
      getTimeEntryDateValidationError({
        dateWorked: "2024-03-01",
        today: "2024-03-01",
      }),
    ).toBeNull();
  });

  test("rejects the adjacent days outside the allowed window", () => {
    expect(
      getTimeEntryDateValidationError({
        dateWorked: "2023-12-01",
        today: "2024-03-01",
      }),
    ).toBe("Date worked cannot be more than 90 days ago");
    expect(
      getTimeEntryDateValidationError({
        dateWorked: "2024-03-02",
        today: "2024-03-01",
      }),
    ).toBe("Date worked cannot be in the future");
  });

  test("rejects malformed and nonexistent worked dates", () => {
    for (const dateWorked of [
      "2024-02-30",
      "2024-2-29",
      "2024-02-29T00:00:00Z",
      "not-a-date",
    ]) {
      expect(
        getTimeEntryDateValidationError({
          dateWorked,
          today: "2024-03-01",
        }),
      ).toBe("Date worked must be a valid calendar date");
    }
  });

  test("fails fast when the internally supplied current day is invalid", () => {
    expect(() =>
      getTimeEntryDateValidationError({
        dateWorked: "2024-02-29",
        today: "2024-02-30",
      }),
    ).toThrow("Current date must be a normalized ISO calendar date");
  });
});
