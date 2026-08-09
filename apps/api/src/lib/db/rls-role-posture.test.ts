import { describe, expect, test } from "bun:test";

import { applicationRlsRolePostureViolation } from "@/api/lib/db/rls-role-posture";

describe("application RLS role posture", () => {
  test.each([
    [undefined, "Application RLS role is missing."],
    [
      { canLogin: true, ownsRlsTable: false },
      "Application RLS role must not permit login.",
    ],
    [
      { canLogin: false, ownsRlsTable: true },
      "Application RLS role must not own RLS-protected tables.",
    ],
    [{ canLogin: false, ownsRlsTable: false }, null],
  ])("classifies %#", (posture, expected) => {
    expect(applicationRlsRolePostureViolation(posture)).toBe(expected);
  });
});
