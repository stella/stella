import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { BILLING_STATUS } from "@/api/db/schema";
import type { AuditEvent } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import updateTimeEntryById from "./update";

type UpdateTimeEntryCtx = Parameters<typeof updateTimeEntryById.handler>[0];

afterEach(() => {
  setSystemTime();
});

const createContext = ({
  safeDb,
  scopedDb,
  body,
  recordAuditEvent,
}: {
  safeDb: UpdateTimeEntryCtx["safeDb"];
  scopedDb: UpdateTimeEntryCtx["scopedDb"];
  body: UpdateTimeEntryCtx["body"];
  recordAuditEvent: UpdateTimeEntryCtx["recordAuditEvent"];
}): UpdateTimeEntryCtx =>
  asTestRaw<UpdateTimeEntryCtx>({
    body,
    safeDb,
    scopedDb,
    workspaceId: toSafeId<"workspace">("workspace_test"),
    memberRole: { role: "owner" },
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test"),
    },
    user: { id: toSafeId<"user">("user_test") },
    recordAuditEvent,
  });

describe("updateTimeEntryById", () => {
  test("excludes narrative and invoiceNarrative from the recorded audit diff", async () => {
    const recordedEvents: AuditEvent[] = [];
    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        timeEntries: {
          findFirst: async () => ({
            status: BILLING_STATUS.DRAFT,
            dateWorked: "2026-06-14",
            timezoneId: "UTC",
            durationMinutes: 30,
            billedMinutes: 30,
            narrative: "Old client-sensitive narrative",
            invoiceNarrative: "Old invoice narrative",
            billable: true,
            noCharge: false,
            workItemId: toSafeId<"entity">("matter_test"),
            userId: toSafeId<"user">("user_test"),
            taskCode: null,
            activityCode: null,
            rateAtEntry: 10_000,
            currency: "USD",
          }),
        },
      },
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [
              { id: toSafeId<"timeEntry">("time_entry_test") },
            ],
          }),
        }),
      }),
    });

    const result = await updateTimeEntryById.handler(
      createContext({
        safeDb,
        scopedDb,
        body: {
          id: toSafeId<"timeEntry">("time_entry_test"),
          narrative: "New client-sensitive narrative",
          invoiceNarrative: "New invoice narrative",
          durationMinutes: 45,
        },
        recordAuditEvent: async (_tx, event) => {
          for (const e of Array.isArray(event) ? event : [event]) {
            recordedEvents.push(e);
          }
        },
      }),
    );

    expect(result).toEqual({
      id: toSafeId<"timeEntry">("time_entry_test"),
    });
    expect(recordedEvents).toHaveLength(1);
    const { changes } = recordedEvents.at(0) ?? {};
    expect(changes).not.toBeUndefined();
    expect(changes).not.toHaveProperty("narrative");
    expect(changes).not.toHaveProperty("invoiceNarrative");
    // Non-free-text fields are still diffed.
    expect(changes).toHaveProperty("durationMinutes", {
      old: 30,
      new: 45,
    });
  });

  test("preserves the snapshotted rate on an unrelated billable edit", async () => {
    let appliedUpdates: Record<string, unknown> | undefined;
    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        timeEntries: {
          findFirst: async () => ({
            status: BILLING_STATUS.DRAFT,
            dateWorked: "2026-06-14",
            timezoneId: "UTC",
            durationMinutes: 30,
            billedMinutes: 30,
            narrative: "Original narrative",
            invoiceNarrative: null,
            billable: true,
            noCharge: false,
            workItemId: null,
            userId: toSafeId<"user">("user_test"),
            taskCode: null,
            activityCode: null,
            rateAtEntry: 10_000,
            currency: "USD",
          }),
        },
      },
      update: () => ({
        set: (updates: Record<string, unknown>) => {
          appliedUpdates = updates;
          return {
            where: () => ({
              returning: async () => [
                { id: toSafeId<"timeEntry">("time_entry_test") },
              ],
            }),
          };
        },
      }),
    });

    const result = await updateTimeEntryById.handler(
      createContext({
        safeDb,
        scopedDb,
        body: {
          id: toSafeId<"timeEntry">("time_entry_test"),
          dateWorked: "2026-06-14",
          timezoneId: "Europe/Prague",
          billable: true,
          narrative: "Updated narrative",
        },
        recordAuditEvent: async () => undefined,
      }),
    );

    expect(result).toEqual({
      id: toSafeId<"timeEntry">("time_entry_test"),
    });
    expect(appliedUpdates).not.toHaveProperty("rateAtEntry");
    expect(appliedUpdates).not.toHaveProperty("currency");
    expect(appliedUpdates).not.toHaveProperty("timezoneId");
  });

  test("persists the timezone used to validate an edited date", async () => {
    setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    let appliedUpdates: Record<string, unknown> | undefined;
    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        timeEntries: {
          findFirst: async () => ({
            status: BILLING_STATUS.DRAFT,
            dateWorked: "2026-08-07",
            timezoneId: "UTC",
            durationMinutes: 30,
            billedMinutes: 30,
            narrative: "Original narrative",
            invoiceNarrative: null,
            billable: false,
            noCharge: false,
            workItemId: null,
            userId: toSafeId<"user">("user_test"),
            taskCode: null,
            activityCode: null,
            rateAtEntry: 0,
            currency: "XXX",
          }),
        },
      },
      update: () => ({
        set: (updates: Record<string, unknown>) => {
          appliedUpdates = updates;
          return {
            where: () => ({
              returning: async () => [
                { id: toSafeId<"timeEntry">("time_entry_test") },
              ],
            }),
          };
        },
      }),
    });

    const result = await updateTimeEntryById.handler(
      createContext({
        safeDb,
        scopedDb,
        body: {
          id: toSafeId<"timeEntry">("time_entry_test"),
          dateWorked: "2026-08-08",
          timezoneId: "Europe/Prague",
        },
        recordAuditEvent: async () => undefined,
      }),
    );

    expect(result).toEqual({
      id: toSafeId<"timeEntry">("time_entry_test"),
    });
    expect(appliedUpdates).toMatchObject({
      dateWorked: "2026-08-08",
      timezoneId: "Europe/Prague",
    });
  });

  test("compares every mutable value before replacing an entry", async () => {
    let compareAndSetParams: unknown[] = [];
    const workItemId = toSafeId<"entity">("work_item_compare_test");
    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        timeEntries: {
          findFirst: async () => ({
            status: BILLING_STATUS.DRAFT,
            dateWorked: "2026-07-11",
            timezoneId: "Europe/Vienna",
            durationMinutes: 37,
            billedMinutes: 42,
            narrative: "Original concurrency narrative",
            invoiceNarrative: "Original invoice concurrency narrative",
            billable: true,
            noCharge: true,
            workItemId,
            userId: toSafeId<"user">("user_test"),
            taskCode: "L310",
            activityCode: "A103",
            rateAtEntry: 12_345,
            currency: "CHF",
          }),
        },
      },
      update: () => ({
        set: () => ({
          where: (condition: SQL) => {
            compareAndSetParams = new PgDialect().sqlToQuery(condition).params;
            return {
              returning: async () => [
                { id: toSafeId<"timeEntry">("time_entry_test") },
              ],
            };
          },
        }),
      }),
    });

    await updateTimeEntryById.handler(
      createContext({
        safeDb,
        scopedDb,
        body: {
          id: toSafeId<"timeEntry">("time_entry_test"),
          narrative: "Replacement narrative",
        },
        recordAuditEvent: async () => undefined,
      }),
    );

    expect(compareAndSetParams).toEqual(
      expect.arrayContaining([
        BILLING_STATUS.DRAFT,
        "2026-07-11",
        "Europe/Vienna",
        37,
        42,
        "Original concurrency narrative",
        "Original invoice concurrency narrative",
        true,
        workItemId,
        "L310",
        "A103",
        12_345,
        "CHF",
      ]),
    );
  });
});
