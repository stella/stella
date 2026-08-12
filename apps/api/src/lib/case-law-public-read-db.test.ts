import { describe, expect, test } from "bun:test";

import {
  assertCaseLawDatabaseRolePermissions,
  PUBLIC_CASE_LAW_RELATIONS,
} from "@/api/lib/case-law-public-read-db";

describe("external public case-law database boundary", () => {
  test("excludes tenant-scoped case-law relations", () => {
    expect(PUBLIC_CASE_LAW_RELATIONS).not.toContain("case_law_matter_links");
  });

  test("accepts a case-law-only read role", () => {
    expect(() =>
      assertCaseLawDatabaseRolePermissions({
        canReadCaseLaw: true,
        canReadOtherData: false,
        canWriteCaseLaw: false,
      }),
    ).not.toThrow();
  });

  test.each([
    {
      canReadCaseLaw: false,
      canReadOtherData: false,
      canWriteCaseLaw: false,
    },
    {
      canReadCaseLaw: true,
      canReadOtherData: false,
      canWriteCaseLaw: true,
    },
    {
      canReadCaseLaw: true,
      canReadOtherData: true,
      canWriteCaseLaw: false,
    },
  ])("rejects an over- or under-privileged role", (permissions) => {
    expect(() => assertCaseLawDatabaseRolePermissions(permissions)).toThrow(
      "CASE_LAW_DATABASE_URL must use a role that can only read the public case-law corpus",
    );
  });
});
