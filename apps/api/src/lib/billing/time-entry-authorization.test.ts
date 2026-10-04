import { describe, expect, test } from "bun:test";

import {
  canApproveTimeEntries,
  canManageTimeEntry,
} from "@/api/lib/billing/time-entry-authorization";
import { toSafeId } from "@/api/lib/branded-types";
import { sessionMemberRole } from "@/api/lib/permission-authorization";

const CURRENT_USER_ID = toSafeId<"user">(
  "00000000-0000-4000-8000-000000000001",
);
const OTHER_USER_ID = toSafeId<"user">("00000000-0000-4000-8000-000000000002");

describe("time entry authorization", () => {
  test("only firm reviewers can approve entries", () => {
    expect(canApproveTimeEntries(sessionMemberRole("owner"))).toBe(true);
    expect(canApproveTimeEntries(sessionMemberRole("admin"))).toBe(true);
    expect(canApproveTimeEntries(sessionMemberRole("member"))).toBe(false);
    expect(canApproveTimeEntries(sessionMemberRole("intern"))).toBe(false);
    expect(canApproveTimeEntries(sessionMemberRole("external"))).toBe(false);
  });

  test("timekeepers manage only their own entries while reviewers manage the matter ledger", () => {
    for (const role of ["member", "intern"] as const) {
      expect(
        canManageTimeEntry({
          memberRole: sessionMemberRole(role),
          currentUserId: CURRENT_USER_ID,
          entryUserId: CURRENT_USER_ID,
        }),
      ).toBe(true);
      expect(
        canManageTimeEntry({
          memberRole: sessionMemberRole(role),
          currentUserId: CURRENT_USER_ID,
          entryUserId: OTHER_USER_ID,
        }),
      ).toBe(false);
    }

    for (const role of ["owner", "admin"] as const) {
      expect(
        canManageTimeEntry({
          memberRole: sessionMemberRole(role),
          currentUserId: CURRENT_USER_ID,
          entryUserId: OTHER_USER_ID,
        }),
      ).toBe(true);
      expect(
        canManageTimeEntry({
          memberRole: sessionMemberRole(role),
          currentUserId: CURRENT_USER_ID,
          entryUserId: null,
        }),
      ).toBe(true);
    }
  });
});
