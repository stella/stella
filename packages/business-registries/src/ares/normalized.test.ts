import { describe, expect, test } from "bun:test";

import { toNormalizedEntity, toNormalizedSearchResult } from "./normalized.js";
import type { AresCompany } from "./types.js";

const company: AresCompany = {
  ico: "27082440",
  name: "Example a.s.",
  legalForm: "121",
  address: {
    street: "Example Street",
    houseNumber: "1",
    orientationNumber: "2",
    orientationLetter: "A",
    municipalityPart: "District",
    municipality: "Prague",
    postalCode: "11000",
    district: "Prague",
    country: "Česká republika",
    textAddress: "Example Street 1/2A, Prague",
  },
  dateEstablished: "2003-08-26",
  dateRegistered: "2003-08-26",
  czNace: [],
  registryUrl: "https://ares.gov.cz/ekonomicke-subjekty?ico=27082440",
  status: "AKTIVNI",
  courtFile: { court: "Městský soud v Praze", section: "B", insert: "8573" },
  shareCapital: "10 000 000 Kc",
  statutoryBodies: [
    {
      organName: "Představenstvo",
      members: [
        {
          name: "Alex Example",
          role: "člen",
          address: null,
          since: "2024-01-01",
        },
      ],
    },
  ],
  actingClause: "Two members act jointly.",
};

describe("ARES normalized projection", () => {
  test("preserves rich registry fields and declares unsupported fields", () => {
    const entity = toNormalizedEntity(company, { vrLoaded: true });
    expect(entity.registryId.scheme).toBe("CZ-ICO");
    expect(String(entity.registryId.value)).toBe("27082440");
    expect(entity.registryRecord).toMatchObject({
      availability: "available",
      value: { reference: "B 8573 Městský soud v Praze" },
    });
    expect(entity.keyPeople).toMatchObject({
      availability: "available",
      value: [{ people: [{ name: "Alex Example" }] }],
    });
    expect(entity.shareCapital).toMatchObject({
      availability: "available",
      value: { text: "10 000 000 Kc" },
    });
    expect(entity.nameWithoutLegalForm).toEqual({
      availability: "not-supported",
    });
    expect(entity.shareCapitalPaid).toEqual({
      availability: "not-supported",
    });
  });

  test("does not confuse skipped enrichment with absent registry data", () => {
    const entity = toNormalizedEntity(company, { vrLoaded: false });
    expect(entity.keyPeople).toEqual({ availability: "not-loaded" });
    expect(entity.registryRecord).toEqual({ availability: "not-loaded" });
    expect(entity.actingClause).toEqual({ availability: "not-loaded" });
  });

  test("makes sparse search-result coverage explicit", () => {
    const result = toNormalizedSearchResult({
      ico: company.ico,
      name: company.name,
      address: company.address?.textAddress ?? null,
    });
    expect(result).toMatchObject({
      address: {
        availability: "available",
        value: company.address?.textAddress,
      },
      legalForm: { availability: "not-supported" },
      registryUrl: { availability: "not-supported" },
      status: { availability: "not-supported" },
    });
  });
});
