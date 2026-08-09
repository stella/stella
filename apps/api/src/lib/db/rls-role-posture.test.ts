import { describe, expect, test } from "bun:test";

import { applicationRlsRolePostureViolation } from "@/api/lib/db/rls-role-posture";

describe("application RLS role posture", () => {
  test.each([
    [undefined, "Application RLS role is missing."],
    [
      {
        bypassesRls: false,
        canLogin: true,
        isSuperuser: false,
        ownsRlsTable: false,
      },
      "Application RLS role must not permit login.",
    ],
    [
      {
        bypassesRls: true,
        canLogin: false,
        isSuperuser: false,
        ownsRlsTable: false,
      },
      "Application RLS role must not bypass row security.",
    ],
    [
      {
        bypassesRls: false,
        canLogin: false,
        isSuperuser: true,
        ownsRlsTable: false,
      },
      "Application RLS role must not bypass row security.",
    ],
    [
      {
        bypassesRls: false,
        canLogin: false,
        isSuperuser: false,
        ownsRlsTable: true,
      },
      "Application RLS role must not own RLS-protected tables.",
    ],
    [
      {
        bypassesRls: false,
        canLogin: false,
        isSuperuser: false,
        ownsRlsTable: false,
      },
      null,
    ],
  ])("classifies %#", (posture, expected) => {
    expect(applicationRlsRolePostureViolation(posture)).toBe(expected);
  });
});
