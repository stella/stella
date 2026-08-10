import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { canApproveTimeEntries, canManageTimeEntry } from "./authorization";

const CURRENT_USER_ID = toSafeId<"user">(
  "00000000-0000-4000-8000-000000000001",
);
const OTHER_USER_ID = toSafeId<"user">("00000000-0000-4000-8000-000000000002");

describe("time entry authorization", () => {
  test("only firm reviewers can approve entries", () => {
    expect(canApproveTimeEntries({ role: "owner" })).toBe(true);
    expect(canApproveTimeEntries({ role: "admin" })).toBe(true);
    expect(canApproveTimeEntries({ role: "member" })).toBe(false);
    expect(canApproveTimeEntries({ role: "intern" })).toBe(false);
    expect(canApproveTimeEntries({ role: "external" })).toBe(false);
  });

  test("timekeepers manage only their own entries while reviewers manage the matter ledger", () => {
    for (const role of ["member", "intern"] as const) {
      expect(
        canManageTimeEntry({
          memberRole: { role },
          currentUserId: CURRENT_USER_ID,
          entryUserId: CURRENT_USER_ID,
        }),
      ).toBe(true);
      expect(
        canManageTimeEntry({
          memberRole: { role },
          currentUserId: CURRENT_USER_ID,
          entryUserId: OTHER_USER_ID,
        }),
      ).toBe(false);
    }

    for (const role of ["owner", "admin"] as const) {
      expect(
        canManageTimeEntry({
          memberRole: { role },
          currentUserId: CURRENT_USER_ID,
          entryUserId: OTHER_USER_ID,
        }),
      ).toBe(true);
      expect(
        canManageTimeEntry({
          memberRole: { role },
          currentUserId: CURRENT_USER_ID,
          entryUserId: null,
        }),
      ).toBe(true);
    }
  });
});
