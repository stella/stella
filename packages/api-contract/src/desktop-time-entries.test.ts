import { expect, test } from "bun:test";
import * as v from "valibot";

import {
  DESKTOP_ACTIVITY_REVIEW_LIMIT,
  desktopMatterCandidatesResponseSchema,
  desktopTimeEntryBatchSchema,
  desktopTimeEntryBatchStatusRequestSchema,
  desktopTimeEntryBatchStatusSchema,
} from "./desktop-time-entries";

const entry = {
  matterId: "00000000-0000-4000-8000-000000000001",
  dateWorked: "2026-10-09",
  timezoneId: "Europe/Prague",
  durationMinutes: 6,
  narrative: "Reviewed document",
  billable: true,
};
test("desktop batch permits only reviewed billing fields and bounded whole durations", () => {
  const body = { idempotencyKey: "day-review", entries: [entry] };
  expect(v.safeParse(desktopTimeEntryBatchSchema, body).success).toBe(true);
  for (const invalid of [
    { ...body, entries: [] },
    {
      ...body,
      entries: Array.from(
        { length: DESKTOP_ACTIVITY_REVIEW_LIMIT + 1 },
        () => entry,
      ),
    },
    { ...body, entries: [{ ...entry, durationMinutes: 1.5 }] },
    { ...body, entries: [{ ...entry, durationMinutes: 1441 }] },
    { ...body, entries: [{ ...entry, windowTitle: "private" }] },
    { ...body, organizationId: "untrusted" },
    { ...body, idempotencyKey: "" },
  ]) {
    expect(v.safeParse(desktopTimeEntryBatchSchema, invalid).success).toBe(
      false,
    );
  }
});
test("desktop candidates require complete local-matching signals and a bounded response", () => {
  const matter = {
    id: entry.matterId,
    name: "Matter",
    reference: "M-1",
    color: null,
    clientName: null,
    signals: {
      lastWorkedAt: null,
      newlyAssignedAt: null,
      upcomingDeadline: null,
    },
  };
  expect(
    v.safeParse(desktopMatterCandidatesResponseSchema, { matters: [matter] })
      .success,
  ).toBe(true);
  expect(
    v.safeParse(desktopMatterCandidatesResponseSchema, {
      matters: [{ ...matter, signals: { lastWorkedAt: null } }],
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(desktopMatterCandidatesResponseSchema, {
      matters: Array.from(
        { length: DESKTOP_ACTIVITY_REVIEW_LIMIT + 1 },
        () => matter,
      ),
    }).success,
  ).toBe(false);
});

test("batch recovery accepts only a key and distinguishes committed receipts from cancellation", () => {
  expect(
    v.safeParse(desktopTimeEntryBatchStatusRequestSchema, {
      idempotencyKey: "retry",
    }).success,
  ).toBe(true);
  expect(
    v.safeParse(desktopTimeEntryBatchStatusRequestSchema, {
      idempotencyKey: "retry",
      windowTitle: "private",
    }).success,
  ).toBe(false);
  for (const valid of [
    { type: "cancelled" },
    { type: "committed", entries: [{ id: "entry", matterId: entry.matterId }] },
  ]) {
    expect(v.safeParse(desktopTimeEntryBatchStatusSchema, valid).success).toBe(
      true,
    );
  }
  for (const invalid of [
    { type: "missing" },
    { type: "committed", entries: [] },
    { type: "cancelled", entries: [] },
  ]) {
    expect(
      v.safeParse(desktopTimeEntryBatchStatusSchema, invalid).success,
    ).toBe(false);
  }
});
