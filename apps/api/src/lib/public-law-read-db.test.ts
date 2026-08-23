import { describe, expect, test } from "bun:test";

import {
  assertPublicLawDatabaseRolePermissions,
  type PublicLawDatabaseRolePermissions,
} from "@/api/lib/public-law-read-db";
import { PUBLIC_LAW_COLUMNS_BY_RELATION } from "@/api/lib/public-law-relations";

const VALID_PERMISSIONS = {
  canConnect: true,
  canReadPublicLaw: true,
  canReadOtherData: false,
  canUseSchema: true,
  canWritePublicLaw: false,
} as const satisfies PublicLawDatabaseRolePermissions;

describe("external public-law database boundary", () => {
  test("excludes tenant and operational relations", () => {
    expect(PUBLIC_LAW_COLUMNS_BY_RELATION).not.toHaveProperty(
      "case_law_matter_links",
    );
    expect(PUBLIC_LAW_COLUMNS_BY_RELATION.case_law_sources).not.toContain(
      "config",
    );
    expect(PUBLIC_LAW_COLUMNS_BY_RELATION.legislation_sources).not.toContain(
      "config",
    );
  });

  test("accepts the exact public-law reader", () => {
    expect(() =>
      assertPublicLawDatabaseRolePermissions(VALID_PERMISSIONS),
    ).not.toThrow();
  });

  test.each([
    { ...VALID_PERMISSIONS, canConnect: false },
    { ...VALID_PERMISSIONS, canReadPublicLaw: false },
    { ...VALID_PERMISSIONS, canReadOtherData: true },
    { ...VALID_PERMISSIONS, canUseSchema: false },
    { ...VALID_PERMISSIONS, canWritePublicLaw: true },
  ] satisfies PublicLawDatabaseRolePermissions[])(
    "rejects an over- or under-privileged role",
    (permissions) => {
      expect(() => assertPublicLawDatabaseRolePermissions(permissions)).toThrow(
        "PUBLIC_LAW_DATABASE_URL must use a role that can only read the public-law corpus",
      );
    },
  );
});
