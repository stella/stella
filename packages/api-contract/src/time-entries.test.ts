import { expect, test } from "bun:test";

import { TIME_ENTRY_SOURCES } from "./billing";
import { parseTimeEntryListPage } from "./time-entries";
import type { TimeEntry } from "./time-entry-types";

test("every canonical entry source survives list response parsing", () => {
  for (const source of TIME_ENTRY_SOURCES) {
    const item = {
      id: "entry",
      source,
      status: "draft",
      activityCode: null,
      billable: true,
      billedMinutes: 30,
      createdAt: "2026-10-08T10:00:00Z",
      currency: "CZK",
      dateWorked: "2026-10-08",
      durationMinutes: 30,
      invoiceNarrative: null,
      narrative: "Confirmed work",
      narrativeLanguage: null,
      noCharge: false,
      rateAtEntry: 1000,
      taskCode: null,
      timerStartedAt: null,
      timerStoppedAt: null,
      timezoneId: "Europe/Prague",
      updatedAt: null,
      userId: "user",
      userName: "Test",
      workItemId: null,
    } as const satisfies TimeEntry;
    const page = { items: [item], limit: 20, nextCursor: null };
    expect(parseTimeEntryListPage(page)).toEqual(page);
    expect(
      parseTimeEntryListPage({
        ...page,
        items: [{ ...item, source: "unknown" }],
      }),
    ).toBeNull();
  }
});
