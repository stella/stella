import { describe, expect, test } from "bun:test";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";

import { manualTimeEntryValues } from "./manual-time-entry-form.logic";

describe("manual entry activity boundary", () => {
  test("internal work strips client billing even after switching from billable client work", () => {
    for (const billable of [true, false]) {
      const fields = {
        dateWorked: "2026-09-30",
        durationMinutes: 37,
        narrative: " Internal planning ",
        narrativeLanguage: "en",
        billable,
      };
      const internal = manualTimeEntryValues({
        ...fields,
        activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
      });
      expect(internal).toEqual({
        activityGroup: TIME_ENTRY_ACTIVITY_GROUP.INTERNAL,
        dateWorked: fields.dateWorked,
        durationMinutes: 37,
        narrative: "Internal planning",
        narrativeLanguage: "en",
      });
      const client = manualTimeEntryValues({
        ...fields,
        activityGroup: TIME_ENTRY_ACTIVITY_GROUP.CLIENT,
      });
      expect(client).toHaveProperty("billable", billable);
    }
  });
});
