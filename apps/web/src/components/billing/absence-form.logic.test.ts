import { describe, expect, test } from "bun:test";

import {
  absenceRequestFromForm,
  canRejectAbsence,
  initialAbsenceValues,
} from "./absence-form.logic";

describe("absence request calendar boundaries", () => {
  test("inclusive last days convert to exclusive ends across month, year and leap boundaries", () => {
    for (const [date, exclusive] of [
      ["2026-01-31", "2026-02-01"],
      ["2026-12-31", "2027-01-01"],
      ["2028-02-29", "2028-03-01"],
    ] as const) {
      const request = absenceRequestFromForm(
        initialAbsenceValues(date),
        "Europe/Prague",
      );
      expect(request).toMatchObject({
        type: "valid",
        body: {
          startDate: date,
          endDate: exclusive,
          timezoneId: "Europe/Prague",
          coverage: { type: "full" },
        },
      });
    }
  });

  test("each half-day segment is valid only for one calendar day", () => {
    for (const segment of ["morning", "afternoon"] as const) {
      const values = {
        ...initialAbsenceValues("2026-10-25"),
        coverage: { type: "half", segment },
      } as const;
      expect(absenceRequestFromForm(values, "Europe/Prague")).toMatchObject({
        type: "valid",
        body: { endDate: "2026-10-26", coverage: { type: "half", segment } },
      });
      expect(
        absenceRequestFromForm(
          { ...values, lastDay: "2026-10-26" },
          "Europe/Prague",
        ),
      ).toEqual({ type: "invalid", reason: "half_range" });
    }
  });

  test("invalid and reversed ranges cannot reach the request body", () => {
    for (const lastDay of ["", "2026-02-30", "2026-09-30"]) {
      expect(
        absenceRequestFromForm(
          { ...initialAbsenceValues("2026-10-01"), lastDay },
          "UTC",
        ),
      ).toEqual({ type: "invalid", reason: "range" });
    }
  });
});

test("rejection requires nonblank bounded feedback", () => {
  for (const comment of ["", " ", "\t\n", "x".repeat(2001)]) {
    expect(canRejectAbsence(comment)).toBe(false);
  }
  for (const comment of [
    "Use the agreed dates",
    " Please revise ",
    "x".repeat(2000),
  ]) {
    expect(canRejectAbsence(comment)).toBe(true);
  }
});
