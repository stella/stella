import { describe, expect, test } from "bun:test";

import {
  assertPublicLawDatabaseRolePermissions,
  type PublicLawDatabaseRolePermissions,
} from "@/api/lib/public-law-read-db";
import { PUBLIC_LAW_COLUMNS_BY_RELATION } from "@/api/lib/public-law-relations";

const VALID_PERMISSIONS = {
  canUseOtherRole: false,
  canConnect: true,
  canDelegatePublicLaw: false,
  canReadPublicLaw: true,
  canReadOtherData: false,
  canUseSequence: false,
  canUseSchema: true,
  canWritePublicLaw: false,
  hasPrivilegedRoleAttributes: false,
  hasPublicLawReaderUsage: true,
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
    expect(PUBLIC_LAW_COLUMNS_BY_RELATION.legislation_documents).toEqual(
      expect.arrayContaining([
        "citation_authority",
        "content_hash",
        "indexed_hash",
      ]),
    );
    expect(PUBLIC_LAW_COLUMNS_BY_RELATION.legislation_documents).not.toContain(
      "metadata",
    );
  });

  test("accepts the exact public-law reader", () => {
    expect(() =>
      assertPublicLawDatabaseRolePermissions(VALID_PERMISSIONS),
    ).not.toThrow();
  });

  test.each([
    { ...VALID_PERMISSIONS, canUseOtherRole: true },
    { ...VALID_PERMISSIONS, canConnect: false },
    { ...VALID_PERMISSIONS, canDelegatePublicLaw: true },
    { ...VALID_PERMISSIONS, canReadPublicLaw: false },
    { ...VALID_PERMISSIONS, canReadOtherData: true },
    { ...VALID_PERMISSIONS, canUseSequence: true },
    { ...VALID_PERMISSIONS, canUseSchema: false },
    { ...VALID_PERMISSIONS, canWritePublicLaw: true },
    { ...VALID_PERMISSIONS, hasPrivilegedRoleAttributes: true },
    { ...VALID_PERMISSIONS, hasPublicLawReaderUsage: false },
  ] satisfies PublicLawDatabaseRolePermissions[])(
    "rejects an over- or under-privileged role",
    (permissions) => {
      expect(() => assertPublicLawDatabaseRolePermissions(permissions)).toThrow(
        "PUBLIC_LAW_DATABASE_URL must use a role that can only read the public-law corpus",
      );
    },
  );
});
