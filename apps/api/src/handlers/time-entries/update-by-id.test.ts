import { describe, expect, test } from "bun:test";

import { BILLING_STATUS } from "@/api/db/schema";
import type { AuditEvent } from "@/api/lib/audit-log";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import updateTimeEntryById from "./update";

type UpdateTimeEntryCtx = Parameters<typeof updateTimeEntryById.handler>[0];

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

describe("updateTimeEntryById (audit diff privacy)", () => {
  test("excludes narrative and invoiceNarrative from the recorded audit diff", async () => {
    const recordedEvents: AuditEvent[] = [];
    const { safeDb, scopedDb } = createScopedDbMock({
      query: {
        timeEntries: {
          findFirst: async () => ({
            status: BILLING_STATUS.DRAFT,
            dateWorked: "2026-06-14",
            durationMinutes: 30,
            billedMinutes: 30,
            narrative: "Old client-sensitive narrative",
            invoiceNarrative: "Old invoice narrative",
            billable: true,
            noCharge: false,
            matterId: toSafeId<"entity">("matter_test"),
            taskCode: null,
            activityCode: null,
            rateAtEntry: 10_000,
            currency: "USD",
          }),
        },
      },
      update: () => ({
        set: () => ({
          where: async () => undefined,
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
});
