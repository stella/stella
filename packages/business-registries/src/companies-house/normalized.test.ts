import { describe, expect, test } from "bun:test";

import companyFixture from "./__fixtures__/company-tesco.json" with { type: "json" };
import officersFixture from "./__fixtures__/officers-tesco.json" with { type: "json" };
import searchFixture from "./__fixtures__/search-tesco.json" with { type: "json" };
import { toNormalizedEntity, toNormalizedSearchResult } from "./normalized.js";
import {
  parseCompanyProfile,
  parseOfficersResponse,
  parseSearchResponse,
} from "./parse.js";
import type {
  CompaniesHouseRawCompanyProfile,
  CompaniesHouseRawOfficersResponse,
  CompaniesHouseRawSearchResponse,
} from "./types.js";

/* eslint-disable typescript-eslint/no-unsafe-type-assertion -- captured official fixtures */
const companyRaw = companyFixture as unknown as CompaniesHouseRawCompanyProfile;
const officersRaw =
  officersFixture as unknown as CompaniesHouseRawOfficersResponse;
const searchRaw = searchFixture as unknown as CompaniesHouseRawSearchResponse;
/* eslint-enable typescript-eslint/no-unsafe-type-assertion */

describe("Companies House normalized projection", () => {
  test("distinguishes separately loaded officers from unsupported fields", () => {
    const company = parseCompanyProfile(companyRaw);
    const withoutOfficers = toNormalizedEntity(company);
    expect(withoutOfficers.keyPeople).toEqual({ availability: "not-loaded" });

    const withOfficers = toNormalizedEntity(company, {
      officers: parseOfficersResponse(officersRaw),
    });
    expect(withOfficers.keyPeople.availability).toBe("available");
    if (withOfficers.keyPeople.availability !== "available") {
      return;
    }
    expect(withOfficers.keyPeople.value[0]?.people.length).toBeGreaterThan(0);
    const datedOfficer = withOfficers.keyPeople.value[0]?.people.find(
      (person) => person.birthDate !== null,
    );
    expect(datedOfficer?.birthDate?.precision).toBe("month");
    expect(withOfficers.shareCapital).toEqual({
      availability: "not-supported",
    });
  });

  test("keeps status, address, legal form, and URL in search rows", () => {
    const first = parseSearchResponse(searchRaw)[0];
    expect(first).toBeDefined();
    if (!first) {
      return;
    }
    const result = toNormalizedSearchResult(first);
    expect(result.registryId.scheme).toBe("GB-CRN");
    expect(result).toMatchObject({
      address: { availability: "available" },
      legalForm: { availability: "available" },
      registryUrl: { availability: "available" },
      status: { availability: "available" },
    });
  });
});
