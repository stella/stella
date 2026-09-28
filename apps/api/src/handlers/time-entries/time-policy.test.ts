import { Result } from "better-result";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";

import { BILLING_STATUS } from "@/api/db/schema";
import { deleteTimeEntryHandler } from "@/api/handlers/time-entries/delete";
import { createTimeEntryHandler } from "@/api/handlers/time-entries/time-entry-insert";
import { updateTimeEntryHandler } from "@/api/handlers/time-entries/update";
import { toSafeId } from "@/api/lib/branded-types";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

const organizationId = toSafeId<"organization">("org_test");
const workspaceId = toSafeId<"workspace">("workspace_test");
const userId = toSafeId<"user">("user_test");
const entryId = toSafeId<"timeEntry">("entry_test");
const defaultPolicy = {
  timeMinimumUnitMinutes: 6,
  timeEditWindowDays: 90,
  timeLockedThroughMonth: null,
  timeNarrativeRequired: true,
};

const entry = {
  organizationId,
  status: BILLING_STATUS.DRAFT,
  dateWorked: "2026-08-31",
  timezoneId: "UTC",
  durationMinutes: 7,
  billedMinutes: 12,
  narrative: "Original work",
  invoiceNarrative: null,
  billable: false,
  noCharge: false,
  workItemId: null,
  userId,
  taskCode: null,
  activityCode: null,
  rateAtEntry: 0,
  currency: "XXX",
};

afterEach(() => setSystemTime());

describe("time entry policy at API write paths", () => {
  test("create rejects a blank narrative only when required", async () => {
    setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const { safeDb } = createScopedDbMock({
      query: {
        organizationSettings: { findFirst: async () => defaultPolicy },
      },
    });
    const result = await Result.gen(() =>
      createTimeEntryHandler({
        safeDb,
        organizationId,
        workspaceId,
        userId,
        memberRole: { role: "member" },
        recordAuditEvent: async () => {},
        body: {
          dateWorked: "2026-09-01",
          timezoneId: "UTC",
          durationMinutes: 7,
          narrative: " ",
          billable: false,
        },
      }),
    );
    expect(Result.isError(result) && result.error.code).toBe(
      "narrative_required",
    );
  });

  test("an approver cannot edit the last day of a locked month", async () => {
    setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const { safeDb } = createScopedDbMock({
      query: {
        organizationSettings: {
          findFirst: async () => ({
            ...defaultPolicy,
            timeLockedThroughMonth: "2026-08-31",
          }),
        },
        timeEntries: { findFirst: async () => entry },
      },
      update: () => {
        throw new Error("locked entry must not be updated");
      },
    });
    const result = await Result.gen(() =>
      updateTimeEntryHandler({
        safeDb,
        workspaceId,
        actor: { userId, memberRole: { role: "owner" } },
        recordAuditEvent: async () => {},
        body: { id: entryId, durationMinutes: 10 },
      }),
    );
    expect(Result.isError(result) && result.error.code).toBe(
      "time_period_locked",
    );
  });

  test("non-approver edit window rejects an older entry", async () => {
    setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const { safeDb } = createScopedDbMock({
      query: {
        organizationSettings: {
          findFirst: async () => ({ ...defaultPolicy, timeEditWindowDays: 0 }),
        },
        timeEntries: { findFirst: async () => entry },
      },
      update: () => {
        throw new Error("expired entry must not be updated");
      },
    });
    const result = await Result.gen(() =>
      updateTimeEntryHandler({
        safeDb,
        workspaceId,
        actor: { userId, memberRole: { role: "member" } },
        recordAuditEvent: async () => {},
        body: { id: entryId, durationMinutes: 10 },
      }),
    );
    expect(Result.isError(result) && result.error.code).toBe(
      "outside_edit_window",
    );
  });

  test("non-approver cannot delete an entry outside the edit window", async () => {
    setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    const { safeDb } = createScopedDbMock({
      query: {
        organizationSettings: {
          findFirst: async () => ({ ...defaultPolicy, timeEditWindowDays: 0 }),
        },
        timeEntries: { findFirst: async () => entry },
      },
      delete: () => {
        throw new Error("expired entry must not be deleted");
      },
    });
    const result = await Result.gen(() =>
      deleteTimeEntryHandler({
        safeDb,
        workspaceId,
        actor: { userId, memberRole: { role: "member" } },
        recordAuditEvent: async () => {},
        body: { id: entryId },
      }),
    );
    expect(Result.isError(result) && result.error.code).toBe(
      "outside_edit_window",
    );
  });

  test("update rounds with a non-default unit", async () => {
    setSystemTime(new Date("2026-09-01T12:00:00.000Z"));
    let billedMinutes: number | undefined;
    const { safeDb } = createScopedDbMock({
      query: {
        organizationSettings: {
          findFirst: async () => ({
            ...defaultPolicy,
            timeMinimumUnitMinutes: 15,
          }),
        },
        timeEntries: { findFirst: async () => entry },
      },
      update: () => ({
        set: (values: { billedMinutes?: number }) => {
          billedMinutes = values.billedMinutes;
          return {
            where: () => ({ returning: async () => [{ id: entryId }] }),
          };
        },
      }),
    });
    const result = await Result.gen(() =>
      updateTimeEntryHandler({
        safeDb,
        workspaceId,
        actor: { userId, memberRole: { role: "owner" } },
        recordAuditEvent: async () => {},
        body: { id: entryId, durationMinutes: 16 },
      }),
    );
    expect(Result.isError(result)).toBe(false);
    expect(billedMinutes).toBe(30);
  });
});
