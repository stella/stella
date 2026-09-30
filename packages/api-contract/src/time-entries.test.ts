import { describe, expect, test } from "bun:test";

import { parseTimeEntryListPage } from "./time-entries";
import type { TimeEntry } from "./time-entry-types";

const ENTRY = {
  activityCode: null,
  billable: true,
  billedMinutes: 30,
  createdAt: "2026-09-30T12:00:00Z",
  currency: "EUR",
  dateWorked: "2026-09-30",
  durationMinutes: 30,
  id: "entry-1",
  invoiceNarrative: null,
  narrative: "Review contract",
  narrativeLanguage: "en",
  noCharge: false,
  rateAtEntry: 10_000,
  returnComment: null,
  source: "manual",
  status: "draft",
  taskCode: null,
  timerStartedAt: null,
  timerStoppedAt: null,
  timezoneId: "UTC",
  updatedAt: null,
  userId: "user-1",
  userName: "Reviewer",
  workItemId: null,
} as const satisfies TimeEntry;

describe("returned time entry comments", () => {
  test("list parsing retains nullable comments and free text exactly", () => {
    for (const returnComment of [
      null,
      "",
      "Explain the work performed.",
      "وضّح العمل المنجز\nReview § 3 <contract>",
    ]) {
      const entry = { ...ENTRY, returnComment };
      const page = { items: [entry], limit: 50, nextCursor: null };

      expect(parseTimeEntryListPage(page)).toEqual(page);
    }
  });

  test("missing or invalid comments reject the whole page instead of disappearing", () => {
    const { returnComment: _returnComment, ...withoutComment } = ENTRY;
    expect(
      parseTimeEntryListPage({
        items: [ENTRY, withoutComment],
        limit: 50,
        nextCursor: null,
      }),
    ).toBeNull();
    for (const returnComment of [undefined, 0, false, {}, []]) {
      expect(
        parseTimeEntryListPage({
          items: [ENTRY, { ...ENTRY, returnComment }],
          limit: 50,
          nextCursor: null,
        }),
      ).toBeNull();
    }
  });
});
