import { describe, expect, test } from "bun:test";

import type { VatTreatment } from "@stll/invoicing";

import {
  addressCountry,
  buyerSnapshotFromContact,
  contactTaxIdentifiers,
  decideInvoiceVat,
  EU_VAT_ID_SQL_PATTERN,
  euVatPrefix,
  invoiceDueDays,
  isWellFormedEuVatId,
  isWellFormedNonEuTaxId,
  latestDate,
  patchContactTaxIdentifiers,
} from "./invoice-prefill.logic";
import type { InvoiceVatReason } from "./invoice-prefill.logic";

type VatCase = {
  name: string;
  seller: {
    country: string | null;
    vatId: string | null;
    vatPayer: boolean;
  } | null;
  buyerVatId: string | null;
  buyerVatPayer: boolean | null;
  buyerCountry: string | null;
  expected: [VatTreatment, number, InvoiceVatReason];
};

const VAT_CASES: VatCase[] = [
  {
    name: "the Greek EL VAT prefix identifies an EU-established seller",
    seller: { country: null, vatId: "EL123456789", vatPayer: true },
    buyerVatId: null,
    buyerVatPayer: null,
    buyerCountry: "US",
    expected: ["outside_scope", 0, "outside_scope"],
  },
  {
    name: "the Northern Ireland XI registration does not make a service seller EU-established",
    seller: { country: null, vatId: "XI123456789", vatPayer: true },
    buyerVatId: null,
    buyerVatPayer: null,
    buyerCountry: "GB",
    expected: ["domestic_vat", 2100, "domestic_rate"],
  },
  {
    name: "a British seller billing a British client retains its configured domestic rate",
    seller: { country: "GB", vatId: "GB123456789", vatPayer: true },
    buyerVatId: "GB987654321",
    buyerVatPayer: true,
    buyerCountry: "GB",
    expected: ["domestic_vat", 2100, "domestic_rate"],
  },
  {
    name: "a non-EU establishment does not acquire EU rules through a secondary VAT registration",
    seller: { country: "GB", vatId: "SK2120123456", vatPayer: true },
    buyerVatId: null,
    buyerVatPayer: null,
    buyerCountry: "GB",
    expected: ["domestic_vat", 2100, "domestic_rate"],
  },
  {
    name: "the seller's German establishment decides whether the buyer is domestic",
    seller: { country: "Germany", vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "DE298765432",
    buyerVatPayer: true,
    buyerCountry: "DE",
    expected: ["domestic_vat", 2100, "domestic_rate"],
  },
  {
    name: "a private client outside the EU is outside the scope (zákon 222/2004 Z. z. § 16 ods. 15, 16 písm. c)",
    seller: { country: null, vatId: "SK2120123456", vatPayer: true },
    buyerVatId: null,
    buyerVatPayer: null,
    buyerCountry: "US",
    expected: ["outside_scope", 0, "outside_scope"],
  },
  {
    name: "an EU-established non-payer billing a non-EU client is outside the scope too",
    seller: { country: "SK", vatId: null, vatPayer: false },
    buyerVatId: null,
    buyerVatPayer: null,
    buyerCountry: "CH",
    expected: ["outside_scope", 0, "outside_scope"],
  },
  {
    name: "a non-payer with a VAT ID billing an EU business is reverse charged (§ 72 ods. 2, § 74 ods. 1 písm. k)",
    seller: { country: null, vatId: "SK2120123456", vatPayer: false },
    buyerVatId: "DE298765432",
    buyerVatPayer: null,
    buyerCountry: "DE",
    expected: ["reverse_charge", 0, "reverse_charge"],
  },
  {
    name: "a non-payer billing a domestic client charges none",
    seller: { country: null, vatId: "SK2120123456", vatPayer: false },
    buyerVatId: "SK2020123456",
    buyerVatPayer: null,
    buyerCountry: "SK",
    expected: ["not_vat_payer", 0, "seller_not_vat_payer"],
  },
  {
    name: "no seller profile keeps lines at 0 %",
    seller: null,
    buyerVatId: "CZ87654321",
    buyerVatPayer: null,
    buyerCountry: "CZ",
    expected: ["domestic_vat", 0, "no_seller_profile"],
  },
  {
    name: "a seller who is not a VAT payer charges none",
    seller: { country: null, vatId: null, vatPayer: false },
    buyerVatId: "DE298765432",
    buyerVatPayer: null,
    buyerCountry: "DE",
    expected: ["not_vat_payer", 0, "seller_not_vat_payer"],
  },
  {
    name: "a registered person with a VAT ID who is not a payer charges none",
    seller: { country: null, vatId: "CZ12345678", vatPayer: false },
    buyerVatId: null,
    buyerVatPayer: null,
    buyerCountry: null,
    expected: ["not_vat_payer", 0, "seller_not_vat_payer"],
  },
  {
    name: "a business in another member state with a matching address is reverse charged",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "de 298 765 432",
    buyerVatPayer: null,
    buyerCountry: "DE",
    expected: ["reverse_charge", 0, "reverse_charge"],
  },
  {
    name: "a country written out in full confirms the VAT ID",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "DE298765432",
    buyerVatPayer: null,
    buyerCountry: "Germany",
    expected: ["reverse_charge", 0, "reverse_charge"],
  },
  {
    name: "a Greek VAT ID (EL) matches a Greek address (GR)",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "EL123456789",
    buyerVatPayer: null,
    buyerCountry: "GR",
    expected: ["reverse_charge", 0, "reverse_charge"],
  },
  {
    name: "a business client outside the EU is outside the scope of VAT",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "GB123456789",
    buyerVatPayer: null,
    buyerCountry: "United Kingdom",
    expected: ["outside_scope", 0, "outside_scope"],
  },
  {
    name: "a Northern Ireland VAT ID (XI) is a UK service client, not an EU one",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "XI123456789",
    buyerVatPayer: null,
    buyerCountry: "GB",
    expected: ["outside_scope", 0, "outside_scope"],
  },
  {
    name: "a free-text tax ID of a Czech client keeps the standard rate",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "HRB123456",
    buyerVatPayer: null,
    buyerCountry: "CZ",
    expected: ["domestic_vat", 2100, "client_country_unconfirmed"],
  },
  {
    name: "a prefixed tax ID without the member state's VAT ID syntax keeps the standard rate",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "DEAB",
    buyerVatPayer: null,
    buyerCountry: "DE",
    expected: ["domestic_vat", 2100, "client_vat_id_invalid"],
  },
  {
    name: "a client outside the EU is outside the scope whatever its tax ID (Art. 44, 59(c))",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "GBAB",
    buyerVatPayer: null,
    buyerCountry: "GB",
    expected: ["outside_scope", 0, "outside_scope"],
  },
  {
    name: "a Swiss business tax ID is outside the scope of VAT",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "CHE-123.456.789 MWST",
    buyerVatPayer: null,
    buyerCountry: "CH",
    expected: ["outside_scope", 0, "outside_scope"],
  },
  {
    name: "a short arbitrary tax ID of a client outside the EU is outside the scope",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "USAB12",
    buyerVatPayer: null,
    buyerCountry: "US",
    expected: ["outside_scope", 0, "outside_scope"],
  },
  {
    name: "a German VAT ID one digit short keeps the standard rate",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "DE29876543",
    buyerVatPayer: null,
    buyerCountry: "DE",
    expected: ["domestic_vat", 2100, "client_vat_id_invalid"],
  },
  {
    name: "a VAT ID the address does not confirm keeps the standard rate",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "DE298765432",
    buyerVatPayer: null,
    buyerCountry: "AT",
    expected: ["domestic_vat", 2100, "client_country_unconfirmed"],
  },
  {
    name: "a missing address country keeps the standard rate",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "DE298765432",
    buyerVatPayer: null,
    buyerCountry: null,
    expected: ["domestic_vat", 2100, "client_country_unconfirmed"],
  },
  {
    name: "a client in the seller's own state pays the standard rate",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "CZ87654321",
    buyerVatPayer: null,
    buyerCountry: "DE",
    expected: ["domestic_vat", 2100, "domestic_rate"],
  },
  {
    name: "a bare registration number names no country",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "27145689",
    buyerVatPayer: null,
    buyerCountry: "CZ",
    expected: ["domestic_vat", 2100, "domestic_rate"],
  },
  {
    name: "a registered non-payer business with a foreign VAT ID is reverse charged",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: "DE298765432",
    buyerVatPayer: false,
    buyerCountry: "DE",
    expected: ["reverse_charge", 0, "reverse_charge"],
  },
  {
    name: "a private client pays the standard rate",
    seller: { country: null, vatId: "CZ12345678", vatPayer: true },
    buyerVatId: null,
    buyerVatPayer: null,
    buyerCountry: "AT",
    expected: ["domestic_vat", 2100, "domestic_rate"],
  },
];

describe("invoice VAT decision", () => {
  test.each(VAT_CASES)(
    "$name",
    ({ seller, buyerVatId, buyerVatPayer, buyerCountry, expected }) => {
      const decision = decideInvoiceVat({
        seller,
        buyerVatId,
        buyerVatPayer,
        buyerCountry,
        standardRateBps: 2100,
      });
      expect([
        decision.vatTreatment,
        decision.vatRateBps,
        decision.reason,
      ]).toEqual(expected);
    },
  );

  test("a VAT payer without a configured rate says so instead of inventing one", () => {
    expect(
      decideInvoiceVat({
        seller: { country: null, vatId: "CZ12345678", vatPayer: true },
        buyerVatId: null,
        buyerVatPayer: null,
        buyerCountry: null,
        standardRateBps: null,
      }),
    ).toEqual({
      vatTreatment: "domestic_vat",
      vatRateBps: 0,
      reason: "no_vat_rate",
    });
  });

  test("only EU member state prefixes name a member state", () => {
    expect(euVatPrefix("EL123456789")).toBe("EL");
    expect(isWellFormedEuVatId("NL 8530.43.775B01")).toBe(true);
    expect(isWellFormedEuVatId("ATU12345678")).toBe(true);
    expect(isWellFormedEuVatId("AT12345678")).toBe(false);
    expect(isWellFormedEuVatId("US123456789")).toBe(false);
    expect(isWellFormedNonEuTaxId("GB123456789")).toBe(true);
    expect(isWellFormedNonEuTaxId("XI123456789")).toBe(true);
    expect(isWellFormedNonEuTaxId("XIAB")).toBe(false);
    expect(isWellFormedNonEuTaxId("NO123456789MVA")).toBe(true);
    expect(isWellFormedNonEuTaxId("US12-3456789")).toBe(true);
    expect(euVatPrefix("GR123456789")).toBeNull();
    expect(euVatPrefix("CZ")).toBeNull();
    expect(euVatPrefix(null)).toBeNull();
  });

  test("an address country is read, never guessed", () => {
    expect(addressCountry("Czechia")).toBe("CZ");
    expect(addressCountry("cz")).toBe("CZ");
    expect(addressCountry("Atlantis")).toBeNull();
    expect(addressCountry("  ")).toBeNull();
    expect(addressCountry(null)).toBeNull();
  });
});

describe("buyer snapshot", () => {
  const contact = {
    displayName: "Example Client a.s.",
    registrationNumber: "27456123",
    taxId: "27456123",
    vatId: "CZ27456123",
    vatPayer: true,
    billingAddress: null,
    addresses: [
      {
        type: "office" as const,
        line1: "Office Street 1",
        city: "Brno",
        isPrimary: true,
      },
      {
        type: "billing" as const,
        line1: "Billing Street 2",
        city: "Praha",
        postalCode: "110 00",
        country: "CZ",
        isPrimary: false,
      },
    ],
  };

  test("prefers the billing address, then a billing-type address", () => {
    expect(buyerSnapshotFromContact(contact)).toEqual({
      buyerName: "Example Client a.s.",
      buyerRegistrationId: "27456123",
      buyerTaxId: "27456123",
      buyerVatId: "CZ27456123",
      buyerAddressLine1: "Billing Street 2",
      buyerAddressLine2: null,
      buyerCity: "Praha",
      buyerPostalCode: "110 00",
      buyerCountry: "CZ",
    });
    expect(
      buyerSnapshotFromContact({
        ...contact,
        billingAddress: { line1: "Invoice Road 3", city: "Plzeň" },
      }),
    ).toMatchObject({
      buyerAddressLine1: "Invoice Road 3",
      buyerCity: "Plzeň",
    });
  });

  test("falls back to the primary address and bounds lengths", () => {
    const snapshot = buyerSnapshotFromContact({
      ...contact,
      displayName: "x".repeat(600),
      addresses: contact.addresses.slice(0, 1),
    });
    expect(snapshot.buyerName).toHaveLength(512);
    expect(snapshot.buyerAddressLine1).toBe("Office Street 1");
  });
});

describe("contact tax and VAT IDs", () => {
  test("an EU VAT number in tax_id with no vat_id reads as the VAT ID", () => {
    // A contact stored before the fields were separated, not yet repaired.
    expect(
      contactTaxIdentifiers({ taxId: "DE298765432", vatId: null }),
    ).toEqual({ taxId: null, vatId: "DE298765432" });
    expect(
      contactTaxIdentifiers({ taxId: "sk 2020 123 456", vatId: "" }),
    ).toEqual({ taxId: null, vatId: "sk 2020 123 456" });
  });

  test("a stored VAT ID and national tax numbers stay where they are", () => {
    expect(
      contactTaxIdentifiers({ taxId: "DE298765432", vatId: "DE111111111" }),
    ).toEqual({ taxId: "DE298765432", vatId: "DE111111111" });
    for (const taxId of ["2020123456", "HRB123456", "GB123456789", "SK12"]) {
      expect(contactTaxIdentifiers({ taxId, vatId: null })).toEqual({
        taxId,
        vatId: null,
      });
    }
  });

  test("an update keeps an explicit clear and classifies only a tax ID it writes", () => {
    const both = { taxId: "DE298765432", vatId: "DE111111111" };
    // Clearing only the VAT ID keeps the tax ID as stored.
    expect(
      patchContactTaxIdentifiers({
        stored: both,
        taxId: undefined,
        vatId: null,
      }),
    ).toEqual({ taxId: "DE298765432", vatId: null });
    // A VAT number typed into the tax ID field becomes the VAT ID.
    expect(
      patchContactTaxIdentifiers({
        stored: { taxId: null, vatId: null },
        taxId: "SK2020123456",
        vatId: undefined,
      }),
    ).toEqual({ taxId: null, vatId: "SK2020123456" });
    // A legacy pair is read by the rule before a new VAT ID replaces it.
    expect(
      patchContactTaxIdentifiers({
        stored: { taxId: "DE298765432", vatId: null },
        taxId: undefined,
        vatId: "DE111111111",
      }),
    ).toEqual({ taxId: null, vatId: "DE111111111" });
    // A national tax number written beside a stored VAT ID stays a tax ID.
    expect(
      patchContactTaxIdentifiers({
        stored: both,
        taxId: "2020123456",
        vatId: undefined,
      }),
    ).toEqual({ taxId: "2020123456", vatId: "DE111111111" });
  });

  test("an un-repaired contact is still reverse charged from its snapshot", () => {
    const snapshot = buyerSnapshotFromContact({
      displayName: "Musterkunde GmbH",
      registrationNumber: null,
      taxId: "DE298765432",
      vatId: null,
      vatPayer: true,
      billingAddress: { line1: "Hauptstraße 1", city: "Berlin", country: "DE" },
      addresses: [],
    });
    expect(snapshot).toMatchObject({
      buyerTaxId: null,
      buyerVatId: "DE298765432",
    });
    expect(
      decideInvoiceVat({
        seller: { country: null, vatId: "CZ12345678", vatPayer: true },
        buyerVatId: snapshot.buyerVatId,
        buyerVatPayer: true,
        buyerCountry: "DE",
        standardRateBps: 2100,
      }).vatTreatment,
    ).toBe("reverse_charge");
  });

  test("the repair's SQL pattern accepts exactly what the rule accepts", () => {
    const sql = new RegExp(EU_VAT_ID_SQL_PATTERN, "u");
    const compact = (value: string) =>
      value.replaceAll(/[\s.-]/gu, "").toUpperCase();
    for (const value of [
      "SK2020123456",
      "CZ12345678",
      "CZ1234567890",
      "DE123456789",
      "ATU12345678",
      "FRXX123456789",
      "NL123456789B01",
      "ESX1234567X",
      "EL123456789",
      "XI123456789",
      "IE1234567WA",
      "sk 2020 123 456",
      "HRB123456",
      "SK12",
      "CZ1234567",
      "2020123456",
      "12345678",
      "HRA 98765",
      "GB123456789",
      "US-EIN-12-3456789",
      "DEAB",
    ]) {
      expect(sql.test(compact(value))).toBe(isWellFormedEuVatId(value));
    }
  });
});

describe("dates and terms", () => {
  test("the client's term wins over the default", () => {
    expect(invoiceDueDays(30)).toEqual({ days: 30, source: "client" });
    expect(invoiceDueDays(null)).toEqual({ days: 14, source: "default" });
  });

  test("the supply date is the latest work date", () => {
    expect(latestDate(["2026-09-02", "2026-09-30", "2026-09-11"], "x")).toBe(
      "2026-09-30",
    );
    expect(latestDate([], "2026-10-12")).toBe("2026-10-12");
  });
});
