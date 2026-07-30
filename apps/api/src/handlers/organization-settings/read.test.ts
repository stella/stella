import { describe, expect, test } from "bun:test";

import { projectOrganizationSettingsRow } from "@/api/handlers/organization-settings/get";

describe("projectOrganizationSettingsRow", () => {
  test("returns the active org's practiceJurisdictions verbatim", () => {
    const result = projectOrganizationSettingsRow(
      {
        documentProcessingMode: "searchable-text",
        matterNumberPadding: 3,
        matterNumberPattern: "{SEQ}",
        practiceJurisdictions: [
          { countryCode: "CZ", isPrimary: true },
          { countryCode: "SK", isPrimary: false },
        ],
        promptCachingEnabled: true,
      },
      true,
    );

    expect(result.practiceJurisdictions).toEqual([
      { countryCode: "CZ", isPrimary: true },
      { countryCode: "SK", isPrimary: false },
    ]);
    expect(result.documentProcessingMode).toBe("searchable-text");
    expect(result.documentOcrAvailable).toBe(true);
  });

  test("defaults practiceJurisdictions to an empty array when no row exists", () => {
    expect(
      projectOrganizationSettingsRow(null, false).practiceJurisdictions,
    ).toEqual([]);
    expect(
      projectOrganizationSettingsRow(undefined, false).practiceJurisdictions,
    ).toEqual([]);
  });

  test("defaults document processing to off when settings do not exist", () => {
    expect(
      projectOrganizationSettingsRow(null, false).documentProcessingMode,
    ).toBe("off");
  });
});
