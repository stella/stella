import { describe, expect, test } from "bun:test";

import {
  applicationRlsRolePostureViolation,
  databaseLoginPostureNotes,
} from "@/api/lib/db/rls-role-posture";

describe("application RLS role posture", () => {
  test.each([
    [undefined, "Application RLS role is missing."],
    [
      {
        bypassesRls: false,
        canAssumeRole: true,
        canLogin: true,
        isSuperuser: false,
        ownsRlsTable: false,
      },
      "Application RLS role must not permit login.",
    ],
    [
      {
        bypassesRls: true,
        canAssumeRole: true,
        canLogin: false,
        isSuperuser: false,
        ownsRlsTable: false,
      },
      "Application RLS role must not bypass row security.",
    ],
    [
      {
        bypassesRls: false,
        canAssumeRole: true,
        canLogin: false,
        isSuperuser: true,
        ownsRlsTable: false,
      },
      "Application RLS role must not bypass row security.",
    ],
    [
      {
        bypassesRls: false,
        canAssumeRole: true,
        canLogin: false,
        isSuperuser: false,
        ownsRlsTable: true,
      },
      "Application RLS role must not own RLS-protected tables.",
    ],
    [
      {
        bypassesRls: false,
        canAssumeRole: false,
        canLogin: false,
        isSuperuser: false,
        ownsRlsTable: false,
      },
      "Database login must be able to assume the application RLS role.",
    ],
    [
      {
        bypassesRls: false,
        canAssumeRole: true,
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

describe("database login posture notes", () => {
  const plainLogin = {
    loginName: "app",
    bypassesRls: false,
    isSuperuser: false,
    ownedPolicyTables: 0,
  };

  test("a login without notable attributes has no notes", () => {
    expect(databaseLoginPostureNotes(plainLogin)).toEqual([]);
  });

  test("lists each notable attribute", () => {
    expect(
      databaseLoginPostureNotes({
        ...plainLogin,
        bypassesRls: true,
        isSuperuser: true,
        ownedPolicyTables: 3,
      }),
    ).toEqual([
      "login is a superuser",
      "login has elevated role attributes",
      "login owns 3 tables with row-level policies",
    ]);
  });
});
