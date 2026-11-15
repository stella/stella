import { describe, expect, test } from "bun:test";

import { ORGANIZATION_LOGO_RULES } from "@stll/auth-model";

import { requireOrganizationLogo } from "@/api/lib/auth/organization-logo-hooks";

describe("requireOrganizationLogo", () => {
  test.each([undefined, null, "", "data:image/webp;base64,UklGRg=="])(
    "accepts %p",
    (logo) => {
      expect(() => requireOrganizationLogo(logo)).not.toThrow();
    },
  );

  test.each([
    "https://example.com/logo.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    'data:image/png;base64,AAAA" onerror="x',
    `data:image/png;base64,${"A".repeat(ORGANIZATION_LOGO_RULES.maxLength)}`,
  ])("rejects %p", (logo) => {
    expect(() => requireOrganizationLogo(logo)).toThrow("Organization logos");
  });
});
