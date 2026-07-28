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
    const datedOfficer = withOfficers.keyPeople.value
      .flatMap(({ people }) => people)
      .find((person) => person.birthDate !== null);
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

  test("does not present a historical appointment bound as an exact date", () => {
    const company = parseCompanyProfile(companyRaw);
    const sourceOfficer = parseOfficersResponse(officersRaw).at(0);
    expect(sourceOfficer).toBeDefined();
    if (!sourceOfficer) {
      return;
    }
    const entity = toNormalizedEntity(company, {
      officers: [
        {
          ...sourceOfficer,
          appointedOn: null,
          appointedBefore: "1992-01-01",
        },
      ],
    });
    expect(entity.keyPeople.availability).toBe("available");
    if (entity.keyPeople.availability !== "available") {
      return;
    }
    expect(entity.keyPeople.value.at(0)?.people.at(0)?.since).toBeNull();
  });

  test("groups current officers by role and excludes resigned appointments", () => {
    const company = parseCompanyProfile(companyRaw);
    const sourceOfficer = parseOfficersResponse(officersRaw).at(0);
    expect(sourceOfficer).toBeDefined();
    if (!sourceOfficer) {
      return;
    }
    const entity = toNormalizedEntity(company, {
      officers: [
        sourceOfficer,
        {
          ...sourceOfficer,
          name: "Former officer",
          resignedOn: "2020-01-01",
          isResigned: true,
        },
        {
          ...sourceOfficer,
          name: "Current secretary",
          role: {
            code: "synthetic-distinct-role",
            title: "Company secretary",
          },
        },
        {
          ...sourceOfficer,
          name: "Localized title",
          role: {
            code: sourceOfficer.role.code,
            title: "Localized display title",
          },
        },
        {
          ...sourceOfficer,
          name: "Same title, distinct code",
          role: {
            code: "synthetic-same-title-role",
            title: "Company secretary",
          },
        },
      ],
    });

    expect(entity.keyPeople.availability).toBe("available");
    if (entity.keyPeople.availability !== "available") {
      return;
    }
    expect(entity.keyPeople.value).toHaveLength(3);
    expect(entity.keyPeople.value.at(0)).toMatchObject({
      name: sourceOfficer.role.code,
      people: [
        expect.objectContaining({
          name: sourceOfficer.name,
          organName: null,
          position: sourceOfficer.role.title ?? sourceOfficer.role.code,
        }),
        expect.objectContaining({
          name: "Localized title",
          position: "Localized display title",
        }),
      ],
    });
    expect(entity.keyPeople.value.at(1)).toMatchObject({
      name: "Company secretary",
      people: [
        expect.objectContaining({
          name: "Current secretary",
          organName: null,
          position: "Company secretary",
        }),
      ],
    });
    expect(entity.keyPeople.value.at(2)).toMatchObject({
      name: "Company secretary",
      people: [expect.objectContaining({ name: "Same title, distinct code" })],
    });
    expect(
      entity.keyPeople.value.flatMap(({ people }) =>
        people.map(({ name }) => name),
      ),
    ).not.toContain("Former officer");
  });

  test("preserves a known cessation date for removed companies", () => {
    const company = parseCompanyProfile(companyRaw);
    const removedAt = "2015-05-05";
    expect(
      toNormalizedEntity({
        ...company,
        status: { type: "removed" },
        dateOfCessation: removedAt,
      }).status,
    ).toEqual({
      availability: "available",
      value: { type: "deleted", at: removedAt },
    });

    const searchResult = parseSearchResponse(searchRaw).at(0);
    expect(searchResult).toBeDefined();
    if (!searchResult) {
      return;
    }
    expect(
      toNormalizedSearchResult({
        ...searchResult,
        status: { type: "removed" },
        dateOfCessation: removedAt,
      }).status,
    ).toEqual({
      availability: "available",
      value: { type: "deleted", at: removedAt },
    });
  });
});
