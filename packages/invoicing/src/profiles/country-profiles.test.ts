import { describe, expect, test } from "bun:test";

import { VAT_TREATMENTS } from "../line-amount";
import {
  INVOICE_COUNTRIES,
  INVOICE_COUNTRY_PROFILES,
  INVOICE_LANGUAGES,
  invoiceCountryOf,
  invoiceSellerCountryOf,
  legalNotesFor,
} from "./country-profiles";

describe("invoice country profiles", () => {
  test("make a wording decision for every country, treatment and language", () => {
    expect(Object.keys(INVOICE_COUNTRY_PROFILES).toSorted()).toEqual(
      [...INVOICE_COUNTRIES].toSorted(),
    );
    for (const country of INVOICE_COUNTRIES) {
      const profile = INVOICE_COUNTRY_PROFILES[country];
      expect(Object.keys(profile.legalNotes).toSorted()).toEqual(
        [...VAT_TREATMENTS].toSorted(),
      );
      expect(Object.keys(profile.supplyDateLabel).toSorted()).toEqual(
        [...INVOICE_LANGUAGES].toSorted(),
      );
      for (const treatment of VAT_TREATMENTS) {
        const note = profile.legalNotes[treatment];
        if (note !== null) {
          expect(Object.keys(note.translations).toSorted()).toEqual(
            [...INVOICE_LANGUAGES].toSorted(),
          );
        }
      }
    }
  });

  test("selects Slovakia from the address country or VAT ID prefix", () => {
    expect(invoiceCountryOf({ country: "SK", vatId: null })).toBe("SK");
    expect(invoiceCountryOf({ country: null, vatId: "SK1234567890" })).toBe(
      "SK",
    );
    expect(invoiceCountryOf({ country: "Austria", vatId: "AT123" })).toBe("EU");
  });

  test.each([
    ["DE", "SK1234567890", "DE", "EU"],
    ["Germany", "SK1234567890", "DE", "EU"],
    ["Slovakia", null, "SK", "SK"],
    ["Slovensko", "CZ12345678", "SK", "SK"],
    ["Czechia", "SK1234567890", "CZ", "CZ"],
    ["unrecognized", "SK1234567890", "SK", "SK"],
    [null, "EL123456789", "GR", "EU"],
    [null, "XI123456789", "GB", "EU"],
  ] as const)(
    "address %s and registration %s share one country decision",
    (country, vatId, resolved, profile) => {
      expect(invoiceSellerCountryOf({ country, vatId })).toBe(resolved);
      expect(invoiceCountryOf({ country, vatId })).toBe(profile);
    },
  );

  test("keeps mandated Slovak wording and appends translations and exemption reasons", () => {
    const profile = INVOICE_COUNTRY_PROFILES.SK;
    expect(
      legalNotesFor({
        profile,
        language: "sk",
        treatments: ["reverse_charge", "reverse_charge"],
      }),
    ).toEqual(["Prenesenie daňovej povinnosti."]);
    expect(
      legalNotesFor({
        profile,
        language: "en",
        treatments: ["reverse_charge", "exempt"],
        exemptionReasons: ["§ 38"],
      }),
    ).toEqual([
      "Prenesenie daňovej povinnosti. Reverse charge.",
      "Dodanie je oslobodené od dane. The supply is exempt from tax. § 38",
    ]);
  });
});
