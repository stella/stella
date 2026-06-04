import { describe, expect, test } from "bun:test";

import { projectOrganizationSettingsRow } from "@/api/handlers/organization-settings/read";

describe("projectOrganizationSettingsRow", () => {
  test("returns the active org's practiceJurisdictions verbatim", () => {
    const result = projectOrganizationSettingsRow({
      matterNumberPadding: 3,
      matterNumberPattern: "{SEQ}",
      practiceJurisdictions: [
        { countryCode: "CZ", isPrimary: true },
        { countryCode: "SK", isPrimary: false },
      ],
      promptCachingEnabled: true,
    });

    expect(result.practiceJurisdictions).toEqual([
      { countryCode: "CZ", isPrimary: true },
      { countryCode: "SK", isPrimary: false },
    ]);
  });

  test("defaults practiceJurisdictions to an empty array when no row exists", () => {
    expect(projectOrganizationSettingsRow(null).practiceJurisdictions).toEqual(
      [],
    );
    expect(
      projectOrganizationSettingsRow(undefined).practiceJurisdictions,
    ).toEqual([]);
  });
});
