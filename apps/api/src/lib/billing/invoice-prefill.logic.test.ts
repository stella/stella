import { describe, expect, test } from "bun:test";

import {
  addressCountry,
  buyerSnapshotFromContact,
  decideInvoiceVat,
  euVatPrefix,
  invoiceDueDays,
  latestDate,
} from "./invoice-prefill.logic";

describe("invoice VAT decision", () => {
  test.each([
    {
      name: "no seller profile keeps lines at 0 %",
      seller: null,
      buyerVatId: "CZ87654321",
      buyerCountry: "CZ",
      expected: ["domestic_vat", 0, "no_seller_profile"],
    },
    {
      name: "a seller who is not a VAT payer charges none",
      seller: { vatId: null, vatPayer: false },
      buyerVatId: "DE298765432",
      buyerCountry: "DE",
      expected: ["not_vat_payer", 0, "seller_not_vat_payer"],
    },
    {
      name: "a registered person with a VAT ID who is not a payer charges none",
      seller: { vatId: "CZ12345678", vatPayer: false },
      buyerVatId: null,
      buyerCountry: null,
      expected: ["not_vat_payer", 0, "seller_not_vat_payer"],
    },
    {
      name: "a business in another member state with a matching address is reverse charged",
      seller: { vatId: "CZ12345678", vatPayer: true },
      buyerVatId: "de 298 765 432",
      buyerCountry: "DE",
      expected: ["reverse_charge", 0, "reverse_charge"],
    },
    {
      name: "a country written out in full confirms the VAT ID",
      seller: { vatId: "CZ12345678", vatPayer: true },
      buyerVatId: "DE298765432",
      buyerCountry: "Germany",
      expected: ["reverse_charge", 0, "reverse_charge"],
    },
    {
      name: "a Greek VAT ID (EL) matches a Greek address (GR)",
      seller: { vatId: "CZ12345678", vatPayer: true },
      buyerVatId: "EL123456789",
      buyerCountry: "GR",
      expected: ["reverse_charge", 0, "reverse_charge"],
    },
    {
      name: "a business client outside the EU with a matching address is reverse charged",
      seller: { vatId: "CZ12345678", vatPayer: true },
      buyerVatId: "GB123456789",
      buyerCountry: "United Kingdom",
      expected: ["reverse_charge", 0, "reverse_charge"],
    },
    {
      name: "a free-text tax ID of a Czech client keeps the standard rate",
      seller: { vatId: "CZ12345678", vatPayer: true },
      buyerVatId: "HRB123456",
      buyerCountry: "CZ",
      expected: ["domestic_vat", 2100, "client_country_unconfirmed"],
    },
    {
      name: "a VAT ID the address does not confirm keeps the standard rate",
      seller: { vatId: "CZ12345678", vatPayer: true },
      buyerVatId: "DE298765432",
      buyerCountry: "AT",
      expected: ["domestic_vat", 2100, "client_country_unconfirmed"],
    },
    {
      name: "a missing address country keeps the standard rate",
      seller: { vatId: "CZ12345678", vatPayer: true },
      buyerVatId: "DE298765432",
      buyerCountry: null,
      expected: ["domestic_vat", 2100, "client_country_unconfirmed"],
    },
    {
      name: "a client in the seller's own state pays the standard rate",
      seller: { vatId: "CZ12345678", vatPayer: true },
      buyerVatId: "CZ87654321",
      buyerCountry: "DE",
      expected: ["domestic_vat", 2100, "domestic_rate"],
    },
    {
      name: "a bare registration number names no country",
      seller: { vatId: "CZ12345678", vatPayer: true },
      buyerVatId: "27145689",
      buyerCountry: "CZ",
      expected: ["domestic_vat", 2100, "domestic_rate"],
    },
    {
      name: "a private client pays the standard rate",
      seller: { vatId: "CZ12345678", vatPayer: true },
      buyerVatId: null,
      buyerCountry: "AT",
      expected: ["domestic_vat", 2100, "domestic_rate"],
    },
  ])("$name", ({ seller, buyerVatId, buyerCountry, expected }) => {
    const decision = decideInvoiceVat({
      seller,
      buyerVatId,
      buyerCountry,
      standardRateBps: 2100,
    });
    expect([
      decision.vatTreatment,
      decision.vatRateBps,
      decision.reason,
    ]).toEqual(expected);
  });

  test("a VAT payer without a configured rate says so instead of inventing one", () => {
    expect(
      decideInvoiceVat({
        seller: { vatId: "CZ12345678", vatPayer: true },
        buyerVatId: null,
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
    taxId: "CZ27456123",
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
