import { describe, expect, test } from "bun:test";

import { projectOrganizationSettingsRow } from "@/api/handlers/organization-settings/get";

describe("projectOrganizationSettingsRow", () => {
  test("returns the active org's practiceJurisdictions verbatim", () => {
    const result = projectOrganizationSettingsRow({
      documentProcessingMode: "searchable-text",
      matterNumberPadding: 3,
      matterNumberPattern: "{SEQ}",
      practiceJurisdictions: [
        { countryCode: "CZ", isPrimary: true },
        { countryCode: "SK", isPrimary: false },
      ],
      promptCachingEnabled: true,
      memoryExtractionEnabled: false,
      timeMinimumUnitMinutes: 6,
      timeEditWindowDays: 90,
      timeLockedThroughMonth: null,
      timeNarrativeRequired: true,
    });

    expect(result.practiceJurisdictions).toEqual([
      { countryCode: "CZ", isPrimary: true },
      { countryCode: "SK", isPrimary: false },
    ]);
    expect(result.documentProcessingMode).toBe("searchable-text");
  });

  test("defaults practiceJurisdictions to an empty array when no row exists", () => {
    expect(projectOrganizationSettingsRow(null).practiceJurisdictions).toEqual(
      [],
    );
    expect(
      projectOrganizationSettingsRow(undefined).practiceJurisdictions,
    ).toEqual([]);
  });

  test("defaults document processing to off when settings do not exist", () => {
    expect(projectOrganizationSettingsRow(null).documentProcessingMode).toBe(
      "off",
    );
  });

  test("defaults time policy when settings do not exist", () => {
    expect(projectOrganizationSettingsRow(null)).toMatchObject({
      timeMinimumUnitMinutes: 6,
      timeEditWindowDays: 90,
      timeLockedThroughMonth: null,
      timeNarrativeRequired: true,
    });
  });
});
