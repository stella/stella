import { describe, expect, test } from "bun:test";

import { BILLING_STATUS } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import deleteTimeEntryById from "./delete-by-id";

type DeleteTimeEntryCtx = Parameters<typeof deleteTimeEntryById.handler>[0];

const createContext = ({
  safeDb,
  scopedDb,
}: {
  safeDb: DeleteTimeEntryCtx["safeDb"];
  scopedDb: DeleteTimeEntryCtx["scopedDb"];
}): DeleteTimeEntryCtx =>
  asTestRaw<DeleteTimeEntryCtx>({
    body: { id: toSafeId<"timeEntry">("time_entry_test") },
    safeDb,
    scopedDb,
    workspaceId: toSafeId<"workspace">("workspace_test"),
    memberRole: { role: "owner" },
    session: {
      activeOrganizationId: toSafeId<"organization">("org_test"),
    },
    user: { id: toSafeId<"user">("user_test") },
    recordAuditEvent: async () => {},
  });

describe("deleteTimeEntryById", () => {
  test("rejects deleting a billed entry", async () => {
    const { getCallCount, safeDb, scopedDb } = createScopedDbMock({
      query: {
        timeEntries: {
          findFirst: async () => ({
            status: BILLING_STATUS.BILLED,
            matterId: toSafeId<"entity">("matter_test"),
            dateWorked: "2026-06-14",
            durationMinutes: 30,
            billedMinutes: 30,
            rateAtEntry: 10_000,
            currency: "USD",
            billable: true,
          }),
        },
      },
      delete: () => {
        throw new Error("delete should not be called for billed entries");
      },
      update: () => {
        throw new Error("update should not be called for billed entries");
      },
    });

    const result = await deleteTimeEntryById.handler(
      createContext({ safeDb, scopedDb }),
    );

    expect(result).toEqual({
      code: 400,
      response: {
        message: "Cannot delete a billed entry; revert the invoice first",
      },
    });
    expect(getCallCount()).toBe(1);
  });
});
