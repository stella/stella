import { describe, expect, test } from "bun:test";

import { ORGANIZATION_ROLE_NAMES } from "@stll/auth-model";

import type { Role } from "@/lib/auth-client";
import { isBillingSettingsAccessible } from "@/routes/_protected.settings/-components/organization/billing-settings.logic";

const ROLE_ACCESS = {
  owner: true,
  admin: true,
  member: false,
  intern: false,
  external: false,
} as const satisfies Record<Role, boolean>;

describe("billing settings access", () => {
  test("requires the preview and an organization management role", () => {
    for (const role of ORGANIZATION_ROLE_NAMES) {
      const expected = ROLE_ACCESS[role];
      expect(isBillingSettingsAccessible({ previewEnabled: true, role })).toBe(
        expected,
      );
      expect(isBillingSettingsAccessible({ previewEnabled: false, role })).toBe(
        false,
      );
    }
    expect(
      isBillingSettingsAccessible({ previewEnabled: true, role: undefined }),
    ).toBe(false);
  });
});
