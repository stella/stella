import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { createTimeEntryHandler } from "@/api/lib/billing/time-entry-insert";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

describe("createTimeEntryHandler", () => {
  test("rejects an invalid IANA timezone id with a typed error", async () => {
    const { safeDb } = createScopedDbMock({
      query: {
        organizationSettings: { findFirst: async () => undefined },
        entities: {
          findFirst: () => {
            throw new Error(
              "should not query the matter for an invalid timezone",
            );
          },
        },
      },
    });

    const result = await Result.gen(() =>
      createTimeEntryHandler({
        safeDb,
        organizationId: toSafeId<"organization">("org_test"),
        workspaceId: toSafeId<"workspace">("workspace_test"),
        userId: toSafeId<"user">("user_test"),
        memberRole: sessionMemberRole("member"),
        recordAuditEvent: async () => {},
        body: {
          workItemId: toSafeId<"entity">("matter_test"),
          dateWorked: "2026-07-01",
          timezoneId: "Not/A_Real_Zone",
          durationMinutes: 30,
          narrative: "test",
        },
      }),
    );

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({
        status: 400,
        message: "Invalid timezone identifier",
      });
    }
  });
});
