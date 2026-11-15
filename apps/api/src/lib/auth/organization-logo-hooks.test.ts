import { describe, expect, test } from "bun:test";

import { ORGANIZATION_LOGO_RULES } from "@stll/auth-model";

import { requireOrganizationLogo } from "@/api/lib/auth/organization-logo-hooks";

// The first bytes of each allowed format, base64 encoded.
const PNG_HEADER = "iVBORw0KGgo=";
const JPEG_HEADER = "/9j/4AAQ";
const WEBP_HEADER = "UklGRgAAAABXRUJQ";

describe("requireOrganizationLogo", () => {
  test.each([
    undefined,
    null,
    "",
    `data:image/png;base64,${PNG_HEADER}`,
    `data:image/jpeg;base64,${JPEG_HEADER}`,
    `data:image/webp;base64,${WEBP_HEADER}`,
  ])("accepts %p", (logo) => {
    expect(() => requireOrganizationLogo(logo)).not.toThrow();
  });

  test.each([
    "https://example.com/logo.png",
    "data:image/svg+xml;base64,PHN2Zz4=",
    'data:image/png;base64,AAAA" onerror="x',
    `data:image/png;base64,${"A".repeat(ORGANIZATION_LOGO_RULES.maxLength)}`,
    // Bytes that are not the declared format.
    "data:image/png;base64,AAAA",
    `data:image/png;base64,${JPEG_HEADER}`,
    `data:image/webp;base64,${PNG_HEADER}`,
    // RIFF without the WEBP form type.
    "data:image/webp;base64,UklGRg==",
    // Too short to hold any header.
    "data:image/jpeg;base64,/9j",
  ])("rejects %p", (logo) => {
    expect(() => requireOrganizationLogo(logo)).toThrow("Organization logos");
  });
});
