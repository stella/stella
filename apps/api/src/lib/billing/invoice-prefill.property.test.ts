import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  contactTaxIdentifiers,
  decideInvoiceVat,
  euVatPrefix,
  isWellFormedEuVatId,
  patchContactTaxIdentifiers,
} from "./invoice-prefill.logic";

const EU_SELLERS = [
  { country: "SK", vatId: "SK2020123456" },
  { country: "CZ", vatId: "CZ12345678" },
  { country: "DE", vatId: "DE123456789" },
  { country: "AT", vatId: "ATU12345678" },
  { country: "PL", vatId: "PL1234567890" },
] as const;

const WELL_FORMED_EU_VAT_IDS = [
  { country: "SK", vatId: "SK2020123456" },
  { country: "CZ", vatId: "CZ12345678" },
  { country: "DE", vatId: "DE123456789" },
  { country: "AT", vatId: "ATU12345678" },
  { country: "PL", vatId: "PL1234567890" },
  { country: "FR", vatId: "FR12345678901" },
] as const;

const NON_EU_COUNTRIES = ["US", "CH", "GB", "CA", "JP", "AU"] as const;

const standardRateArb = fc.option(fc.constantFrom(1900, 2000, 2100, 2300), {
  nil: null,
});

describe("invoice prefill VAT and tax-identifier properties", () => {
  test("contactTaxIdentifiers is idempotent for every taxId/vatId pair", () => {
    const nullableIdArb = fc.option(
      fc.oneof(
        fc.constantFrom("SK2020123456", "DE123456789", "HRB123456", "", "   "),
        fc.string({ maxLength: 20 }),
      ),
      { nil: null },
    );
    assertProperty(
      "contactTaxIdentifiers is idempotent for every taxId/vatId pair",
      fc.property(nullableIdArb, nullableIdArb, (taxId, vatId) => {
        const once = contactTaxIdentifiers({ taxId, vatId });
        const twice = contactTaxIdentifiers(once);
        expect(twice).toEqual(once);
      }),
    );
  });

  test("patchContactTaxIdentifiers preserves explicit vatId clear when taxId is not rewritten", () => {
    assertProperty(
      "patchContactTaxIdentifiers preserves explicit vatId clear when taxId is not rewritten",
      fc.property(
        fc.constantFrom(...WELL_FORMED_EU_VAT_IDS).map((x) => x.vatId),
        (euVat) => {
          const patched = patchContactTaxIdentifiers({
            stored: { taxId: euVat, vatId: null },
            taxId: undefined,
            vatId: null,
          });
          expect(patched).toEqual({ taxId: null, vatId: null });
        },
      ),
    );
  });

  test("without a seller profile VAT is always 0 with no_seller_profile", () => {
    assertProperty(
      "without a seller profile VAT is always 0 with no_seller_profile",
      fc.property(
        fc.option(fc.string({ maxLength: 20 }), { nil: null }),
        fc.option(fc.boolean(), { nil: null }),
        fc.option(fc.constantFrom("SK", "DE", "US", "GB"), { nil: null }),
        standardRateArb,
        (buyerVatId, buyerVatPayer, buyerCountry, standardRateBps) => {
          expect(
            decideInvoiceVat({
              seller: null,
              buyerVatId,
              buyerVatPayer,
              buyerCountry,
              standardRateBps,
            }),
          ).toEqual({
            vatTreatment: "domestic_vat",
            vatRateBps: 0,
            reason: "no_seller_profile",
          });
        },
      ),
    );
  });

  test("EU seller billing a client established outside the EU is always outside_scope with 0 VAT", () => {
    assertProperty(
      "EU seller billing a client established outside the EU is always outside_scope with 0 VAT",
      fc.property(
        fc.constantFrom(...EU_SELLERS),
        fc.boolean(),
        fc.constantFrom(...NON_EU_COUNTRIES),
        fc.option(fc.string({ maxLength: 20 }), { nil: null }),
        fc.option(fc.boolean(), { nil: null }),
        standardRateArb,
        (
          sellerBase,
          vatPayer,
          buyerCountry,
          buyerVatId,
          buyerVatPayer,
          standardRateBps,
        ) => {
          expect(
            decideInvoiceVat({
              seller: { ...sellerBase, vatPayer },
              buyerVatId,
              buyerVatPayer,
              buyerCountry,
              standardRateBps,
            }),
          ).toEqual({
            vatTreatment: "outside_scope",
            vatRateBps: 0,
            reason: "outside_scope",
          });
        },
      ),
    );
  });

  test("EU seller billing a confirmed cross-border EU VAT ID always produces reverse_charge at 0 VAT", () => {
    assertProperty(
      "EU seller billing a confirmed cross-border EU VAT ID always produces reverse_charge at 0 VAT",
      fc.property(
        fc.constantFrom(...EU_SELLERS),
        fc.boolean(),
        fc.constantFrom(...WELL_FORMED_EU_VAT_IDS),
        fc.option(fc.boolean(), { nil: null }),
        standardRateArb,
        (sellerBase, vatPayer, buyer, buyerVatPayer, standardRateBps) => {
          if (buyer.country === sellerBase.country) {
            return;
          }
          expect(euVatPrefix(buyer.vatId)).toBe(buyer.country);
          expect(isWellFormedEuVatId(buyer.vatId)).toBe(true);
          expect(
            decideInvoiceVat({
              seller: { ...sellerBase, vatPayer },
              buyerVatId: buyer.vatId,
              buyerVatPayer,
              buyerCountry: buyer.country,
              standardRateBps,
            }),
          ).toEqual({
            vatTreatment: "reverse_charge",
            vatRateBps: 0,
            reason: "reverse_charge",
          });
        },
      ),
    );
  });

  test("non-domestic VAT treatments always carry 0 vatRateBps", () => {
    assertProperty(
      "non-domestic VAT treatments always carry 0 vatRateBps",
      fc.property(
        fc.option(
          fc.record({
            country: fc.option(fc.constantFrom("SK", "CZ", "DE", "US"), {
              nil: null,
            }),
            vatId: fc.option(
              fc.constantFrom("SK2020123456", "DE123456789", "INVALID"),
              { nil: null },
            ),
            vatPayer: fc.boolean(),
          }),
          { nil: null },
        ),
        fc.option(
          fc.constantFrom(
            "SK2020123456",
            "DE123456789",
            "GB123456789",
            "HRB123456",
          ),
          { nil: null },
        ),
        fc.option(fc.boolean(), { nil: null }),
        fc.option(fc.constantFrom("SK", "CZ", "DE", "US", "GB"), { nil: null }),
        standardRateArb,
        (seller, buyerVatId, buyerVatPayer, buyerCountry, standardRateBps) => {
          const decision = decideInvoiceVat({
            seller,
            buyerVatId,
            buyerVatPayer,
            buyerCountry,
            standardRateBps,
          });
          if (decision.vatTreatment !== "domestic_vat") {
            expect(decision.vatRateBps).toBe(0);
          } else {
            expect(decision.vatRateBps).toBeGreaterThanOrEqual(0);
          }
        },
      ),
    );
  });
});
