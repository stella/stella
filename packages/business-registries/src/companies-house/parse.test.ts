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
/* eslint-disable typescript-eslint/no-unsafe-type-assertion */
const tesco = tescoFixture as unknown as CompaniesHouseRawCompanyProfile;
const arm = armFixture as unknown as CompaniesHouseRawCompanyProfile;
const dissolved =
  dissolvedFixture as unknown as CompaniesHouseRawCompanyProfile;
const search = searchFixture as unknown as CompaniesHouseRawSearchResponse;
const officers =
  officersFixture as unknown as CompaniesHouseRawOfficersResponse;
/* eslint-enable typescript-eslint/no-unsafe-type-assertion */

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

  test("includes care_of and PO box in the composed textAddress", () => {
    // Agent-held / PO-box-only filings have no structured street; if
    // the formatter ignores care_of + po_box the dispatch layer
    // surfaces such addresses as effectively empty.
    const out = parseAddress({
      care_of: "Acme Secretaries Limited",
      po_box: "5000",
      locality: "London",
      postal_code: "EC1A 1AA",
      country: "England",
    });
    expect(out.careOf).toBe("Acme Secretaries Limited");
    expect(out.poBox).toBe("5000");
    expect(out.textAddress).toBe(
      "c/o Acme Secretaries Limited, PO Box 5000, London, EC1A 1AA, England",
    );
  });

  test("renders PO-box-only addresses with no structured street", () => {
    const out = parseAddress({ po_box: "42", postal_code: "SW1A 1AA" });
    expect(out.textAddress).toBe("PO Box 42, SW1A 1AA");
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
    // SIC array shape — live fixture currently shows a single
    // "retail in non-specialised stores" code. Don't pin the exact
    // count here; live values drift when Tesco files a new return.
    expect(out.sicCodes.length).toBeGreaterThan(0);
    expect(out.sicCodes[0]).toMatch(/^\d{4,5}$/u);
  });

  test("derives the active status", () => {
    const out = parseCompanyProfile(tesco);
    expect(out.status).toEqual({ type: "active" });
  });

  test("parses the registered office address", () => {
    const out = parseCompanyProfile(tesco);
    expect(out.registeredOfficeAddress?.locality).toBe("Welwyn Garden City");
    expect(out.registeredOfficeAddress?.postalCode).toBe("AL7 1GA");
    // Companies House surfaces "United Kingdom" for the country slot
    // on E&W-registered entities (the jurisdiction is captured by the
    // separate `jurisdiction` field). Earlier docs-derived fixtures
    // used "England"; the live response uses "United Kingdom".
    expect(out.registeredOfficeAddress?.country).toBe("United Kingdom");
  });

  test("parses the accounts block", () => {
    const out = parseCompanyProfile(tesco);
    // Accounts dates drift annually; assert shape, not specific dates.
    expect(out.accounts?.nextDue).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(out.accounts?.nextMadeUpTo).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(out.accounts?.lastMadeUpTo).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(out.accounts?.overdue).toBe(false);
  });

  test("falls back to period_end_on when deprecated date aliases are absent", () => {
    // Companies House marked `last_accounts.made_up_to` and
    // top-level `next_made_up_to` as deprecated in favour of
    // `period_end_on` on `last_accounts` / `next_accounts`.
    // Profiles served after the cutover omit the deprecated aliases.
    const out = parseCompanyProfile({
      company_name: "ACME LTD",
      company_number: "12345678",
      company_status: "active",
      accounts: {
        next_accounts: {
          due_on: "2027-01-31",
          period_end_on: "2026-07-31",
          overdue: false,
        },
        last_accounts: { period_end_on: "2025-07-31" },
      },
    });
    expect(out.accounts?.lastMadeUpTo).toBe("2025-07-31");
    expect(out.accounts?.nextMadeUpTo).toBe("2026-07-31");
    expect(out.accounts?.nextDue).toBe("2027-01-31");
  });

  test("parses the confirmation statement", () => {
    const out = parseCompanyProfile(tesco);
    expect(out.confirmationStatement?.nextDue).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
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
    expect(out.previousNames.length).toBeGreaterThanOrEqual(1);
    // Most-recent previous name first: live fixture shows
    // "ADVANCED RISC MACHINES LIMITED" effective 1990-12-03 →
    // 1998-05-21, before the 1998 rebrand to ARM.
    expect(out.previousNames[0]?.name).toBe("ADVANCED RISC MACHINES LIMITED");
    expect(out.previousNames[0]?.effectiveFrom).toBe("1990-12-03");
    expect(out.previousNames[0]?.ceasedOn).toBe("1998-05-21");
  });

  test("parses the registered office address", () => {
    const out = parseCompanyProfile(arm);
    // Live ARM Limited records the office on two address lines
    // ("110 Fulbourn Road" + "Cambridge") with the locality set to
    // the wider Cambridgeshire. We assert the postcode + the
    // postcode-resolvable city instead of `region`.
    expect(out.registeredOfficeAddress?.postalCode).toBe("CB1 9NJ");
    expect(out.registeredOfficeAddress?.locality).toBe("Cambridgeshire");
  });
});

describe("parseCompanyProfile (dissolved fixture)", () => {
  test("carries the cessation date into the dissolved status", () => {
    const out = parseCompanyProfile(dissolved);
    // Phones 4U Direct Limited was dissolved 2015-05-05; we test
    // a real dissolved entity rather than synthesising one.
    expect(out.status).toEqual({
      type: "dissolved",
      dissolvedAt: "2015-05-05",
    });
    expect(out.dateOfCessation).toBe("2015-05-05");
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
  test("maps every item in the captured slice", () => {
    const out = parseSearchResponse(search);
    expect(out).toHaveLength(5);
    // Top hit is the parent Tesco PLC.
    expect(out[0]?.companyNumber).toBe("00445790");
    expect(out[0]?.name).toBe("TESCO PLC");
    expect(out[0]?.type).toBe("plc");
  });

  test("preserves the dissolved status on search rows", () => {
    const out = parseSearchResponse(search);
    const dissolvedHit = out.find((item) => item.status.type === "dissolved");
    expect(dissolvedHit?.status.type).toBe("dissolved");
  });

  test("carries the cross-jurisdiction CRN prefix verbatim", () => {
    const out = parseSearchResponse(search);
    // The captured Tesco search slice includes a UK establishment
    // entry with a `BR` prefix CRN. Surfacing it verbatim (no
    // normalisation, no jurisdiction inference) keeps the search
    // result lossless.
    const branch = out.find((item) => item.companyNumber.startsWith("BR"));
    expect(branch).toBeDefined();
  });

  test("returns the address snippet verbatim", () => {
    const out = parseSearchResponse(search);
    // The composed snippet for Tesco PLC includes the postcode and
    // is what the search dropdown surfaces to the user. We pass it
    // through unchanged.
    expect(out[0]?.address).toContain("Welwyn Garden City");
    expect(out[0]?.address).toContain("AL7 1GA");
  });

  test("returns an empty array when items is absent", () => {
    expect(parseSearchResponse({})).toEqual([]);
  });
});

describe("parseOfficersResponse", () => {
  test("maps active officers with month/year DOB", () => {
    const out = parseOfficersResponse(officers);
    expect(out.length).toBeGreaterThan(0);
    // First director in the captured slice — assert the shape, not
    // a specific person (the live officer roster turns over).
    const director = out.find((officer) => officer.role.code === "director");
    expect(director).toBeDefined();
    expect(director?.isResigned).toBe(false);
    expect(director?.dateOfBirth?.month).toBeGreaterThanOrEqual(1);
    expect(director?.dateOfBirth?.month).toBeLessThanOrEqual(12);
    expect(director?.dateOfBirth?.year).toBeGreaterThan(1900);
  });

  test("flags resigned officers via isResigned (synthetic row)", () => {
    // The live Tesco slice happens to contain only currently-serving
    // officers, so exercise the resignation discriminator with a
    // small synthetic payload rather than depending on which named
    // director left this quarter.
    const [resigned] = parseOfficersResponse({
      items: [
        {
          name: "FORMER, Director Person",
          officer_role: "director",
          appointed_on: "2015-01-01",
          resigned_on: "2022-03-31",
        },
      ],
    });
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

  test("parses corporate-officer identification block (synthetic)", () => {
    // Live Tesco slice has no corporate-officer rows; exercise the
    // identification-extraction path with a synthetic row so the
    // contract is pinned regardless of who Tesco appoints next.
    const [secretary] = parseOfficersResponse({
      items: [
        {
          name: "TESCO SECRETARIAT LIMITED",
          officer_role: "corporate-secretary",
          identification: {
            identification_type: "uk-limited-company",
            legal_form: "Private Limited Company",
            place_registered: "United Kingdom",
            registration_number: "01234567",
          },
        },
      ],
    });
    expect(secretary?.identification?.legalForm).toBe(
      "Private Limited Company",
    );
    expect(secretary?.identification?.registrationNumber).toBe("01234567");
    expect(secretary?.dateOfBirth).toBeNull();
  });

  test("returns an empty array when items is absent", () => {
    expect(parseOfficersResponse({})).toEqual([]);
  });

  test("preserves appointed_before for pre-1992 officer rows", () => {
    // Long-serving directors of old companies surface with
    // `appointed_before` + `is_pre_1992_appointment` instead of
    // `appointed_on`. Dropping the field would falsely imply
    // Companies House had no appointment data on file.
    const [officer] = parseOfficersResponse({
      items: [
        {
          name: "OLD, Director",
          officer_role: "director",
          appointed_before: "1992-03-01",
          is_pre_1992_appointment: true,
        },
      ],
    });
    expect(officer?.appointedOn).toBeNull();
    expect(officer?.appointedBefore).toBe("1992-03-01");
  });

  test("falls back to principal_office_address for corporate officers", () => {
    // Registered-overseas corporate / managing officers ship their
    // location via `principal_office_address` rather than the
    // correspondence `address` slot. Without the fallback the
    // officer roster surfaces with `address: null` despite upstream
    // carrying the address.
    const [officer] = parseOfficersResponse({
      items: [
        {
          name: "ACME HOLDINGS LIMITED",
          officer_role: "corporate-director",
          principal_office_address: {
            premises: "1",
            address_line_1: "Capitol Hill",
            locality: "Wilmington",
            postal_code: "19801",
            country: "United States",
          },
        },
      ],
    });
    expect(officer?.address?.locality).toBe("Wilmington");
    expect(officer?.address?.postalCode).toBe("19801");
    expect(officer?.address?.country).toBe("United States");
  });
});
