import { normalizeCountry } from "@stll/agent-input";
import { DEFAULT_INVOICE_DUE_DAYS } from "@stll/api-contract";
import type { VatTreatment } from "@stll/invoicing";

import type {
  BillingAddress,
  ContactAddress,
} from "@/api/db/schema-validators";

/**
 * VAT identification number prefixes of the EU member states (Greece writes
 * EL, Northern Ireland XI). A reverse charge applies between two of them.
 */
const EU_VAT_PREFIXES = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "EL",
  "ES",
  "FI",
  "FR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
  "XI",
]);

const compactVatId = (vatId: string | null) =>
  vatId?.replaceAll(/[\s.-]/gu, "").toUpperCase() ?? "";

/** The member state a VAT ID names, or null when it names none. */
export const euVatPrefix = (vatId: string | null): string | null => {
  const compact = compactVatId(vatId);
  const prefix = compact.slice(0, 2);
  return compact.length > 2 && EU_VAT_PREFIXES.has(prefix) ? prefix : null;
};

/**
 * The country a business VAT or tax ID is written for, when it carries the
 * usual two-letter prefix ("DE298765432", "GB123456789"); null for a bare
 * number, which names no country.
 */
const vatIdCountry = (vatId: string | null): string | null => {
  const compact = compactVatId(vatId);
  return /^[A-Z]{2}[0-9A-Z]{2,}$/u.test(compact) ? compact.slice(0, 2) : null;
};

/**
 * The ISO 3166-1 alpha-2 country a VAT ID prefix stands for. VAT prefixes are
 * ISO codes except Greece, which writes EL, and Northern Ireland, which writes
 * XI under the United Kingdom.
 */
const VAT_PREFIX_COUNTRY: ReadonlyMap<string, string> = new Map([
  ["EL", "GR"],
  ["XI", "GB"],
]);
const countryOfVatPrefix = (prefix: string) =>
  VAT_PREFIX_COUNTRY.get(prefix) ?? prefix;

/**
 * The country an address names, read through the shared country reader
 * ("CZ", "Czechia", "Česká republika"); null when it names none or more than
 * one, so a free-text country is never guessed.
 */
export const addressCountry = (country: string | null): string | null => {
  if (country === null || country.trim() === "") {
    return null;
  }
  const read = normalizeCountry(country, { spelling: "alpha-2" });
  return read.ok ? read.value.alpha2 : null;
};

/** Why the invoice carries the VAT treatment it was given. */
const INVOICE_VAT_REASONS = [
  "no_seller_profile",
  "seller_not_vat_payer",
  "reverse_charge",
  "domestic_rate",
  "no_vat_rate",
  "client_country_unconfirmed",
] as const;
export type InvoiceVatReason = (typeof INVOICE_VAT_REASONS)[number];

export type InvoiceVatDecision = {
  vatTreatment: VatTreatment;
  vatRateBps: number;
  reason: InvoiceVatReason;
};

type DecideInvoiceVatOptions = {
  /** Null when the invoice has no seller profile. */
  seller: { vatId: string | null; vatPayer: boolean } | null;
  buyerVatId: string | null;
  /** The country of the client's address, as written on the contact. */
  buyerCountry: string | null;
  /** The organization's highest VAT rate valid on the supply date. */
  standardRateBps: number | null;
};

const domesticVat = (
  standardRateBps: number | null,
  reason: InvoiceVatReason = "domestic_rate",
): InvoiceVatDecision =>
  standardRateBps === null
    ? { vatTreatment: "domestic_vat", vatRateBps: 0, reason: "no_vat_rate" }
    : { vatTreatment: "domestic_vat", vatRateBps: standardRateBps, reason };

/**
 * The VAT an invoice's lines get from who sells and who buys. A seller
 * profile that is not a VAT payer charges none, even with a VAT ID (a
 * registered person who is not a payer has one). A VAT payer
 * registered in a member state reverse charges a business client abroad
 * (legal services to a business are taxed where the client is), but only
 * when the client's address names a country, that country differs from the
 * seller's, and the client's VAT ID is written for that same country: a
 * free-text tax ID alone ("HRB123456") never removes VAT. When the client's
 * VAT ID names another country the address does not confirm, the seller
 * charges its standard rate and says the country is unconfirmed. Otherwise
 * the standard rate is the organization's highest rate valid on the supply
 * date. Without a seller profile nothing is known, so lines keep 0 %.
 */
export const decideInvoiceVat = ({
  seller,
  buyerVatId,
  buyerCountry,
  standardRateBps,
}: DecideInvoiceVatOptions): InvoiceVatDecision => {
  if (seller === null) {
    return {
      vatTreatment: "domestic_vat",
      vatRateBps: 0,
      reason: "no_seller_profile",
    };
  }
  if (!seller.vatPayer) {
    return {
      vatTreatment: "not_vat_payer",
      vatRateBps: 0,
      reason: "seller_not_vat_payer",
    };
  }
  const sellerState = euVatPrefix(seller.vatId);
  const buyerPrefix = vatIdCountry(buyerVatId);
  if (sellerState === null || buyerPrefix === null) {
    return domesticVat(standardRateBps);
  }
  const sellerCountry = countryOfVatPrefix(sellerState);
  const vatCountry = countryOfVatPrefix(buyerPrefix);
  if (vatCountry === sellerCountry) {
    return domesticVat(standardRateBps);
  }
  if (addressCountry(buyerCountry) !== vatCountry) {
    return domesticVat(standardRateBps, "client_country_unconfirmed");
  }
  return {
    vatTreatment: "reverse_charge",
    vatRateBps: 0,
    reason: "reverse_charge",
  };
};

export type InvoiceBuyerSnapshot = {
  buyerName: string | null;
  buyerRegistrationId: string | null;
  buyerVatId: string | null;
  buyerAddressLine1: string | null;
  buyerAddressLine2: string | null;
  buyerCity: string | null;
  buyerPostalCode: string | null;
  buyerCountry: string | null;
};

export const EMPTY_BUYER_SNAPSHOT = {
  buyerName: null,
  buyerRegistrationId: null,
  buyerVatId: null,
  buyerAddressLine1: null,
  buyerAddressLine2: null,
  buyerCity: null,
  buyerPostalCode: null,
  buyerCountry: null,
} as const satisfies InvoiceBuyerSnapshot;

type BuyerContact = {
  displayName: string;
  registrationNumber: string | null;
  taxId: string | null;
  billingAddress: BillingAddress | null;
  addresses: readonly ContactAddress[] | null;
};

const text = (value: string | undefined | null, max: number) => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed.slice(0, max);
};

/**
 * The buyer as the invoice should print it, copied from the matter's client:
 * the billing address when the contact has one, else its billing-type address,
 * else its primary address. Lengths are bounded to the invoice columns.
 */
export const buyerSnapshotFromContact = (
  contact: BuyerContact,
): InvoiceBuyerSnapshot => {
  const addresses = contact.addresses ?? [];
  const address: BillingAddress | undefined =
    contact.billingAddress?.line1 === undefined
      ? (addresses.find((entry) => entry.type === "billing") ??
        addresses.find((entry) => entry.isPrimary) ??
        addresses.at(0))
      : contact.billingAddress;
  return {
    buyerName: text(contact.displayName, 512),
    buyerRegistrationId: text(contact.registrationNumber, 64),
    buyerVatId: text(contact.taxId, 64),
    buyerAddressLine1: text(address?.line1, 512),
    buyerAddressLine2: text(address?.line2, 512),
    buyerCity: text(address?.city, 256),
    buyerPostalCode: text(address?.postalCode, 32),
    buyerCountry: text(address?.country, 128),
  };
};

/** Days to pay: the client's agreed term, else the default. */
export const invoiceDueDays = (clientPaymentTermDays: number | null) =>
  clientPaymentTermDays !== null && clientPaymentTermDays >= 0
    ? { days: clientPaymentTermDays, source: "client" as const }
    : { days: DEFAULT_INVOICE_DUE_DAYS, source: "default" as const };

/** The latest of the given ISO dates, or `fallback` when there are none. */
export const latestDate = (dates: readonly string[], fallback: string) => {
  let latest: string | null = null;
  for (const date of dates) {
    if (latest === null || date > latest) {
      latest = date;
    }
  }
  return latest ?? fallback;
};
