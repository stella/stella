import { describe, expect, test } from "bun:test";

import { CASE_LAW_JURISDICTIONS } from "@stll/api-contract/case-law-jurisdictions";
import { LANGUAGES } from "@stll/locales";

import {
  PROVISION_EXTRACTION_ADMISSION,
  PROVISION_EXTRACTION_ADMISSION_REVISION,
  PROVISION_EXTRACTION_ADMISSION_SCOPES,
} from "./provision-extraction-admission";

describe("provision extraction admission", () => {
  test("EU extraction admits every known decision country and language", () => {
    expect(PROVISION_EXTRACTION_ADMISSION_REVISION).toBe(2);
    const actual = new Set(
      PROVISION_EXTRACTION_ADMISSION_SCOPES.map(
        ({ jurisdiction, language }) => `${jurisdiction}/${language}`,
      ),
    );
    expect(actual.size).toBe(CASE_LAW_JURISDICTIONS.length * LANGUAGES.length);
    for (const jurisdiction of CASE_LAW_JURISDICTIONS) {
      for (const { code } of LANGUAGES) {
        expect(actual.has(`${jurisdiction}/${code}`)).toBe(true);
      }
    }
    for (const { jurisdiction, language } of Object.values(
      PROVISION_EXTRACTION_ADMISSION,
    )) {
      expect(actual.has(`${jurisdiction}/${language}`)).toBe(true);
    }
  });
});
