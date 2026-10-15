import { expect, test } from "bun:test";

import { parseTimeEntryListPage } from "@stll/api-contract/time-entries";
import type { TimeEntry } from "@stll/api-contract/time-entry-types";

import { toSafeId } from "@/lib/safe-id";

import {
  timeEntryContextKey,
  timeEntryContextUpdate,
  UNAVAILABLE_TIME_ENTRY_CONTEXT,
} from "./time-entry-context.logic";

const entry = {
  activityCode: null,
  billable: true,
  billedMinutes: 60,
  createdAt: "2026-10-05T12:00:00Z",
  currency: "EUR",
  dateWorked: "2026-10-05",
  durationMinutes: 60,
  id: "ledger-entry",
  invoiceNarrative: null,
  narrative: "Work",
  narrativeLanguage: null,
  noCharge: false,
  rateAtEntry: 12_000,
  source: "manual",
  status: "draft",
  taskCode: null,
  timerStartedAt: null,
  timerStoppedAt: null,
  timezoneId: "Europe/Prague",
  updatedAt: null,
  userId: null,
  userName: null,
  workItemId: null,
  workItemReference: { type: "unavailable" },
} as const satisfies TimeEntry;
const page = (row: unknown) => ({ items: [row], limit: 20, nextCursor: null });

test("unavailable context preserves the ledger and its stored link on edit", () => {
  expect(parseTimeEntryListPage(page(entry))?.items).toEqual([entry]);
  expect(timeEntryContextUpdate(entry, "")).toEqual({});
  expect(timeEntryContextUpdate(entry, "replacement")).toEqual({
    workItemId: "replacement",
  });
  expect(UNAVAILABLE_TIME_ENTRY_CONTEXT).toBe("unavailable");
  expect(timeEntryContextKey(entry)).toBe(UNAVAILABLE_TIME_ENTRY_CONTEXT);
});

test("context reference contracts refuse identifiers on unavailable references", () => {
  expect(
    parseTimeEntryListPage(
      page({
        ...entry,
        workItemReference: { type: "unavailable", id: "context" },
      }),
    ),
  ).toBeNull();
  expect(
    parseTimeEntryListPage(page({ ...entry, workItemId: "context" })),
  ).toBeNull();
  expect(
    parseTimeEntryListPage(
      page({
        ...entry,
        workItemId: "context",
        workItemReference: { type: "available", id: "different" },
      }),
    ),
  ).toBeNull();
});

test("preceding additive time-entry responses normalize during an API rollout", () => {
  const { workItemReference: _reference, ...preceding } = entry;
  const parsed = parseTimeEntryListPage(
    page({ ...preceding, workItemId: "context" }),
  );
  expect(parsed?.items.at(0)?.workItemReference).toEqual({
    type: "available",
    id: toSafeId<"entity">("context"),
  });
  expect(
    timeEntryContextUpdate(
      { workItemId: null, workItemReference: null },
      "replacement",
    ),
  ).toEqual({ workItemId: "replacement" });
});
