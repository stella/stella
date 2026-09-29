import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";

import { COUNTRY_CODES } from "@stll/country-codes";

import { contactImportCandidateSchema } from "./contact-import-schema";
import {
  dateOfBirthFromColumns,
  dateOfBirthToColumns,
  validatePersonDetails,
} from "./person-details";

describe("person contact details", () => {
  test("the import draft accepts the full country-code set", () => {
    expect(
      Value.Check(contactImportCandidateSchema, {
        type: "person",
        displayName: "Example Person",
        nationalityCodes: [...COUNTRY_CODES],
      }),
    ).toBe(true);
  });
  test("every date precision roundtrips through typed columns", () => {
    const dates = [
      { precision: "year", year: 1984 },
      { precision: "month", year: 1984, month: 2 },
      { precision: "day", year: 1984, month: 2, day: 29 },
    ] as const;
    for (const date of dates) {
      expect(dateOfBirthFromColumns(dateOfBirthToColumns(date))).toEqual(date);
    }
    expect(dateOfBirthFromColumns(dateOfBirthToColumns(null))).toBeNull();
  });

  test("calendar and country invariants reject invalid person details", () => {
    expect(
      validatePersonDetails({
        type: "person",
        dateOfBirth: { precision: "day", year: 1900, month: 2, day: 29 },
      }),
    ).not.toBeNull();
    expect(
      validatePersonDetails({
        type: "person",
        dateOfBirth: { precision: "day", year: 2000, month: 2, day: 29 },
        nationalityCodes: ["CZ", "BR"],
      }),
    ).toBeNull();
    expect(
      validatePersonDetails({ type: "person", nationalityCodes: ["CZ", "CZ"] }),
    ).not.toBeNull();
    expect(
      validatePersonDetails({ type: "person", nationalityCodes: ["ZZ"] }),
    ).not.toBeNull();
    expect(
      validatePersonDetails({
        type: "organization",
        dateOfBirth: { precision: "year", year: 2000 },
      }),
    ).not.toBeNull();
  });
});
