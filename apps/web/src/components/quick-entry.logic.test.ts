import { describe, expect, test } from "bun:test";

import { APIError } from "@/lib/errors/api";

import {
  emptyQuickEntryValues,
  quickEntryRefusalKey,
} from "./quick-entry.logic";

describe("quick entry reset", () => {
  test("retains only the selected day and restores empty entry defaults", () => {
    for (const date of ["2024-02-29", "2026-09-30", "2026-12-31"]) {
      const saved = {
        ...emptyQuickEntryValues(date),
        durationMinutes: 75,
        narrative: "Drafting a submission",
        narrativeLanguage: "cs",
        billable: false,
      };
      const reset = emptyQuickEntryValues(saved.dateWorked);
      expect(reset).toEqual({
        dateWorked: date,
        durationMinutes: 0,
        narrative: "",
        narrativeLanguage: null,
        billable: true,
      });
      expect(saved.durationMinutes).toBe(75);
      expect(saved.narrativeLanguage).toBe("cs");
    }
  });

  test("returns independent defaults for each new entry", () => {
    const first = emptyQuickEntryValues("2026-09-30");
    const second = emptyQuickEntryValues("2026-09-30");
    expect(first).not.toBe(second);
    first.narrative = "Drafting a submission";
    first.durationMinutes = 30;
    expect(second.narrative).toBe("");
    expect(second.durationMinutes).toBe(0);
  });
});

describe("quick entry refusal messages", () => {
  test("selects actionable messages from typed API error codes", () => {
    for (const [code, key] of [
      ["invalid_date_worked", "billing.quickEntry.invalidDate"],
      ["future_date_worked", "billing.quickEntry.futureDate"],
      ["outside_edit_window", "billing.quickEntry.outsideEditWindow"],
      ["narrative_required", "billing.quickEntry.narrativeRequired"],
      ["time_period_locked", "billing.quickEntry.periodLocked"],
    ] as const) {
      expect(
        quickEntryRefusalKey(
          new APIError({ code, status: 400, message: "Refused" }),
        ),
      ).toBe(key);
    }
  });

  test("shows the generic failure for unknown, missing and untyped codes", () => {
    for (const error of [
      new APIError({ code: "unknown", status: 500, message: "Failed" }),
      new APIError({ status: 500, message: "Failed" }),
      { code: "narrative_required", status: 400, message: "Refused" },
      null,
    ]) {
      expect(quickEntryRefusalKey(error)).toBe("errors.actionFailed");
    }
  });
});
