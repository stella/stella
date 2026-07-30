import { describe, expect, test } from "bun:test";

import { mobileOrganizationSlug } from "./mobile-organization-slug";

describe("mobileOrganizationSlug", () => {
  test("creates a readable unique slug from an organization name", () => {
    expect(mobileOrganizationSlug("Právní Tým & Co.", "a1b2c3d4")).toBe(
      "pravni-tym-co-a1b2c3d4",
    );
  });

  test("uses a stable fallback for names without ASCII letters", () => {
    expect(mobileOrganizationSlug("法律", "a1b2c3d4")).toBe(
      "organization-a1b2c3d4",
    );
  });
});
