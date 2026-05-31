import { describe, expect, test } from "bun:test";

import armFixture from "./__fixtures__/company-arm.json" with { type: "json" };
import dissolvedFixture from "./__fixtures__/company-dissolved.json" with { type: "json" };
import tescoFixture from "./__fixtures__/company-tesco.json" with { type: "json" };
import officersFixture from "./__fixtures__/officers-tesco.json" with { type: "json" };
import searchFixture from "./__fixtures__/search-tesco.json" with { type: "json" };
import {
  parseAddress,
  parseCompanyProfile,
  parseOfficersResponse,
  parseSearchResponse,
} from "./parse.js";
import type {
  CompaniesHouseRawCompanyProfile,
  CompaniesHouseRawOfficersResponse,
  CompaniesHouseRawSearchResponse,
} from "./types.js";

// SAFETY: docs-derived shape fixtures match `CompaniesHouseRaw*` by
// construction; the parser tolerates absent optional fields so the
// cast narrows JSON `unknown` to the documented response type
// without runtime risk.
// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const tesco = tescoFixture as unknown as CompaniesHouseRawCompanyProfile;
// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const arm = armFixture as unknown as CompaniesHouseRawCompanyProfile;
// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const dissolved =
  dissolvedFixture as unknown as CompaniesHouseRawCompanyProfile;
// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const search = searchFixture as unknown as CompaniesHouseRawSearchResponse;
// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
const officers =
  officersFixture as unknown as CompaniesHouseRawOfficersResponse;

describe("parseAddress", () => {
  test("composes textAddress in UK postal order", () => {
    const out = parseAddress({
      premises: "Tesco House",
      address_line_1: "Shire Park",
      address_line_2: "Kestrel Way",
      locality: "Welwyn Garden City",
      postal_code: "AL7 1GA",
      country: "England",
    });
    expect(out.textAddress).toBe(
      "Tesco House Shire Park, Kestrel Way, Welwyn Garden City, AL7 1GA, England",
    );
    expect(out.premises).toBe("Tesco House");
    expect(out.addressLine1).toBe("Shire Park");
    expect(out.locality).toBe("Welwyn Garden City");
    expect(out.postalCode).toBe("AL7 1GA");
    expect(out.country).toBe("England");
  });

  test("handles a minimal one-line + postcode address", () => {
    const out = parseAddress({
      address_line_1: "10 Downing Street",
      postal_code: "SW1A 2AA",
    });
    expect(out.textAddress).toBe("10 Downing Street, SW1A 2AA");
    expect(out.locality).toBeNull();
  });

  test("falls back to nulls on an empty address", () => {
    const out = parseAddress({});
    expect(out.premises).toBeNull();
    expect(out.textAddress).toBeNull();
  });

  test("trims blank string values", () => {
    const out = parseAddress({ address_line_1: "  ", postal_code: "" });
    expect(out.addressLine1).toBeNull();
    expect(out.postalCode).toBeNull();
    expect(out.textAddress).toBeNull();
  });
});

describe("parseCompanyProfile (Tesco PLC fixture)", () => {
  test("maps top-level identifiers", () => {
    const out = parseCompanyProfile(tesco);
    expect(out.companyNumber).toBe("00445790");
    expect(out.name).toBe("TESCO PLC");
    expect(out.type).toBe("plc");
    expect(out.jurisdiction).toBe("england-wales");
    expect(out.dateOfCreation).toBe("1947-11-27");
    expect(out.dateOfCessation).toBeNull();
    expect(out.sicCodes).toEqual(["47110", "70100"]);
  });

  test("derives the active status", () => {
    const out = parseCompanyProfile(tesco);
    expect(out.status).toEqual({ type: "active" });
  });

  test("parses the registered office address", () => {
    const out = parseCompanyProfile(tesco);
    expect(out.registeredOfficeAddress?.locality).toBe("Welwyn Garden City");
    expect(out.registeredOfficeAddress?.postalCode).toBe("AL7 1GA");
    expect(out.registeredOfficeAddress?.country).toBe("England");
  });

  test("parses the accounts block", () => {
    const out = parseCompanyProfile(tesco);
    expect(out.accounts?.nextDue).toBe("2026-11-23");
    expect(out.accounts?.nextMadeUpTo).toBe("2026-02-28");
    expect(out.accounts?.lastMadeUpTo).toBe("2025-02-22");
    expect(out.accounts?.overdue).toBe(false);
  });

  test("parses the confirmation statement", () => {
    const out = parseCompanyProfile(tesco);
    expect(out.confirmationStatement?.nextDue).toBe("2026-12-11");
    expect(out.confirmationStatement?.overdue).toBe(false);
  });

  test("builds a find-and-update registry URL", () => {
    const out = parseCompanyProfile(tesco);
    expect(out.registryUrl).toBe(
      "https://find-and-update.company-information.service.gov.uk/company/00445790",
    );
  });
});

describe("parseCompanyProfile (ARM Holdings fixture)", () => {
  test("carries previous names with from / to dates", () => {
    const out = parseCompanyProfile(arm);
    expect(out.previousNames).toHaveLength(2);
    expect(out.previousNames[0]?.name).toBe("ARM HOLDINGS PLC");
    expect(out.previousNames[0]?.effectiveFrom).toBe("1998-03-17");
    expect(out.previousNames[0]?.ceasedOn).toBe("2016-09-05");
  });

  test("parses both registered-office and service addresses", () => {
    const out = parseCompanyProfile(arm);
    expect(out.registeredOfficeAddress?.region).toBe("Cambridge");
    expect(out.serviceAddress?.postalCode).toBe("CB1 9NJ");
  });
});

describe("parseCompanyProfile (dissolved fixture)", () => {
  test("carries the cessation date into the dissolved status", () => {
    const out = parseCompanyProfile(dissolved);
    expect(out.status).toEqual({
      type: "dissolved",
      dissolvedAt: "2018-09-04",
    });
    expect(out.dateOfCessation).toBe("2018-09-04");
    expect(out.hasBeenLiquidated).toBe(true);
  });
});

describe("parseCompanyProfile status discriminator", () => {
  const baseProfile: CompaniesHouseRawCompanyProfile = {
    company_name: "Test Co",
    company_number: "00000001",
  };

  const profileWithStatus = (
    status: string,
  ): CompaniesHouseRawCompanyProfile => ({
    ...baseProfile,
    company_status: status,
  });

  test("maps every documented company_status enum value", () => {
    expect(parseCompanyProfile(profileWithStatus("active")).status.type).toBe(
      "active",
    );
    expect(
      parseCompanyProfile(profileWithStatus("liquidation")).status.type,
    ).toBe("liquidation");
    expect(
      parseCompanyProfile(profileWithStatus("administration")).status.type,
    ).toBe("administration");
    expect(
      parseCompanyProfile(profileWithStatus("receivership")).status.type,
    ).toBe("receivership");
    expect(
      parseCompanyProfile(profileWithStatus("voluntary-arrangement")).status
        .type,
    ).toBe("voluntary-arrangement");
    expect(
      parseCompanyProfile(profileWithStatus("insolvency-proceedings")).status
        .type,
    ).toBe("insolvency-proceedings");
    expect(
      parseCompanyProfile(profileWithStatus("converted-closed")).status.type,
    ).toBe("converted-closed");
    expect(parseCompanyProfile(profileWithStatus("open")).status.type).toBe(
      "open",
    );
    expect(parseCompanyProfile(profileWithStatus("closed")).status.type).toBe(
      "closed",
    );
    expect(
      parseCompanyProfile(profileWithStatus("registered")).status.type,
    ).toBe("registered");
    expect(parseCompanyProfile(profileWithStatus("removed")).status.type).toBe(
      "removed",
    );
  });

  test("falls through to unknown for missing or unrecognised codes", () => {
    expect(parseCompanyProfile(baseProfile).status).toEqual({
      type: "unknown",
    });
    expect(
      parseCompanyProfile(profileWithStatus("future-status-code")).status,
    ).toEqual({ type: "unknown" });
  });
});

describe("parseSearchResponse", () => {
  test("maps every item with cross-jurisdiction CRNs", () => {
    const out = parseSearchResponse(search);
    expect(out).toHaveLength(5);
    expect(out[0]?.companyNumber).toBe("00445790");
    expect(out[0]?.name).toBe("TESCO PLC");
    expect(out[2]?.companyNumber).toBe("SC141819");
    expect(out[2]?.type).toBe("plc");
  });

  test("preserves the dissolved status on search rows", () => {
    const out = parseSearchResponse(search);
    const dissolvedHit = out.find((item) => item.companyNumber === "01264512");
    expect(dissolvedHit?.status).toEqual({
      type: "dissolved",
      // Search rows do not carry date_of_cessation -> dissolvedAt
      // unless upstream sets it; we surface what the row provided.
      dissolvedAt: "2018-09-04",
    });
  });

  test("prefers address_snippet over composed address", () => {
    const out = parseSearchResponse(search);
    expect(out[0]?.address).toBe(
      "Tesco House, Shire Park, Kestrel Way, Welwyn Garden City, AL7 1GA",
    );
  });

  test("returns an empty array when items is absent", () => {
    expect(parseSearchResponse({})).toEqual([]);
  });
});

describe("parseOfficersResponse", () => {
  test("maps active directors with month/year DOB", () => {
    const out = parseOfficersResponse(officers);
    const ceo = out[0];
    expect(ceo?.name).toBe("MURPHY, Kenneth Anthony");
    expect(ceo?.role.code).toBe("director");
    expect(ceo?.appointedOn).toBe("2020-10-01");
    expect(ceo?.isResigned).toBe(false);
    expect(ceo?.dateOfBirth).toEqual({ month: 8, year: 1966 });
  });

  test("flags resigned officers via isResigned", () => {
    const out = parseOfficersResponse(officers);
    const resigned = out.find((officer) => officer.name.startsWith("ALLAN"));
    expect(resigned?.isResigned).toBe(true);
    expect(resigned?.resignedOn).toBe("2022-03-31");
  });

  test("never carries the day of birth — only month and year", () => {
    const out = parseOfficersResponse(officers);
    // SAFETY: domain shape is `{ month, year }` only; this asserts the
    // narrow type at runtime, not just at compile time.
    for (const officer of out) {
      if (officer.dateOfBirth) {
        expect(Object.keys(officer.dateOfBirth).sort()).toEqual([
          "month",
          "year",
        ]);
      }
    }
  });

  test("parses corporate-secretary identification block", () => {
    const out = parseOfficersResponse(officers);
    const secretary = out.find(
      (officer) => officer.role.code === "corporate-secretary",
    );
    expect(secretary?.identification?.legalForm).toBe(
      "Private Limited Company",
    );
    expect(secretary?.identification?.registrationNumber).toBe("01234567");
    expect(secretary?.dateOfBirth).toBeNull();
  });

  test("returns an empty array when items is absent", () => {
    expect(parseOfficersResponse({})).toEqual([]);
  });
});
