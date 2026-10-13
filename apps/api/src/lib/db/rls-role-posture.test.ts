import { describe, expect, test } from "bun:test";

import { RUNTIME_MODE } from "@stll/runtime-mode";

import {
  applicationRlsRolePostureViolation,
  DatabaseLoginPostureError,
  databaseLoginPostureNotes,
  databaseLoginPostureResult,
  ingestionRolePostureViolation,
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

describe("database login admission", () => {
  const attributes = [
    { isSuperuser: false, bypassesRls: false, admitted: true },
    { isSuperuser: true, bypassesRls: false, admitted: false },
    { isSuperuser: false, bypassesRls: true, admitted: false },
    { isSuperuser: true, bypassesRls: true, admitted: false },
  ];

  test.each(attributes)(
    "enforces role attributes for %# regardless of table ownership",
    ({ isSuperuser, bypassesRls, admitted }) => {
      for (const mode of Object.values(RUNTIME_MODE)) {
        for (const ownedPolicyTables of [0, 3]) {
          for (const unsafeLocalDevOptIn of [undefined, ""]) {
            const result = databaseLoginPostureResult({
              posture: {
                loginName: "app",
                isSuperuser,
                bypassesRls,
                ownedPolicyTables,
              },
              runtimeMode: { mode },
              unsafeLocalDevOptIn,
            });
            expect(result.isOk()).toBe(admitted);
            if (result.isErr()) {
              expect(result.error).toBeInstanceOf(DatabaseLoginPostureError);
              expect(result.error.message).not.toBe("");
            }
          }
        }
      }
    },
  );

  test.each(attributes)(
    "allows the explicit local development opt-in only in open mode for %#",
    ({ isSuperuser, bypassesRls }) => {
      for (const mode of Object.values(RUNTIME_MODE)) {
        const result = databaseLoginPostureResult({
          posture: {
            loginName: "app",
            isSuperuser,
            bypassesRls,
            ownedPolicyTables: 0,
          },
          runtimeMode: { mode },
          unsafeLocalDevOptIn: "1",
        });
        expect(result.isOk()).toBe(mode === RUNTIME_MODE.open);
        if (result.isErr()) {
          expect(result.error).toBeInstanceOf(DatabaseLoginPostureError);
        }
      }
    },
  );

  test("requires the exact opt-in value, including for a demoted login", () => {
    for (const mode of Object.values(RUNTIME_MODE)) {
      for (const unsafeLocalDevOptIn of ["0", "true", "yes", " 1", "1 "]) {
        const result = databaseLoginPostureResult({
          posture: {
            loginName: "app",
            isSuperuser: false,
            bypassesRls: false,
            ownedPolicyTables: 0,
          },
          runtimeMode: { mode },
          unsafeLocalDevOptIn,
        });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error).toBeInstanceOf(DatabaseLoginPostureError);
        }
      }
    }
  });

  test("requires a readable login posture, including with the local development opt-in", () => {
    for (const mode of Object.values(RUNTIME_MODE)) {
      for (const unsafeLocalDevOptIn of [undefined, "", "1"]) {
        const result = databaseLoginPostureResult({
          posture: undefined,
          runtimeMode: { mode },
          unsafeLocalDevOptIn,
        });
        expect(result.isErr()).toBe(true);
        if (result.isErr()) {
          expect(result.error).toBeInstanceOf(DatabaseLoginPostureError);
        }
      }
    }
  });
});

describe("ingestion role posture", () => {
  test.each([
    [undefined, "Ingestion role is missing."],
    [
      { canAssumeRole: false },
      "Database login must be able to assume the ingestion role. Run `bun run db:migrate` to grant SET rights.",
    ],
    [{ canAssumeRole: true }, null],
  ])("classifies %#", (posture, expected) => {
    expect(ingestionRolePostureViolation(posture)).toBe(expected);
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
