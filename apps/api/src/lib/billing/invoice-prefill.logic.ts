import { normalizeCountry } from "@stll/agent-input";
import { DEFAULT_INVOICE_DUE_DAYS } from "@stll/api-contract";
import { EU_MEMBER_STATES } from "@stll/catalogue";
import {
  invoiceCountryForVatPrefix,
  invoiceSellerCountryOf,
} from "@stll/invoicing";
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

/** A United Kingdom VAT number, also behind the Northern Ireland XI prefix. */
const UK_VAT_NUMBER = /^(?:\d{9}|\d{12}|GD\d{3}|HA\d{3})$/u;

/**
 * The number part of each member state's VAT ID, as the VIES service checks
 * its syntax. Only a well-formed VAT ID removes VAT by reverse charge; a
 * prefix with arbitrary characters behind it ("DEAB") does not.
 */
const EU_VAT_ID_FORMATS: ReadonlyMap<string, RegExp> = new Map([
  ["AT", /^U\d{8}$/u],
  ["BE", /^[01]\d{9}$/u],
  ["BG", /^\d{9,10}$/u],
  ["CY", /^\d{8}[A-Z]$/u],
  ["CZ", /^\d{8,10}$/u],
  ["DE", /^\d{9}$/u],
  ["DK", /^\d{8}$/u],
  ["EE", /^\d{9}$/u],
  ["EL", /^\d{9}$/u],
  ["ES", /^[0-9A-Z]\d{7}[0-9A-Z]$/u],
  ["FI", /^\d{8}$/u],
  ["FR", /^[0-9A-HJ-NP-Z]{2}\d{9}$/u],
  ["HR", /^\d{11}$/u],
  ["HU", /^\d{8}$/u],
  ["IE", /^(?:\d{7}[A-W][A-I]?|\d[A-Z+*]\d{5}[A-W])$/u],
  ["IT", /^\d{11}$/u],
  ["LT", /^(?:\d{9}|\d{12})$/u],
  ["LU", /^\d{8}$/u],
  ["LV", /^\d{11}$/u],
  ["MT", /^\d{8}$/u],
  ["NL", /^\d{9}B\d{2}$/u],
  ["PL", /^\d{10}$/u],
  ["PT", /^\d{9}$/u],
  ["RO", /^\d{2,10}$/u],
  ["SE", /^\d{12}$/u],
  ["SI", /^\d{8}$/u],
  ["SK", /^\d{10}$/u],
  ["XI", UK_VAT_NUMBER],
]);

/** Whether a VAT ID with a member-state prefix has that state's syntax. */
export const isWellFormedEuVatId = (vatId: string | null): boolean => {
  const compact = compactVatId(vatId);
  const format = EU_VAT_ID_FORMATS.get(compact.slice(0, 2));
  return format?.test(compact.slice(2)) === true;
};

/**
 * `isWellFormedEuVatId` as a PostgreSQL regular expression over the same
 * compacted value (`EU_VAT_ID_SQL_COMPACT`), derived from the one format map
 * so the repair that moves stored rows cannot drift from the rule.
 */
export const EU_VAT_ID_SQL_PATTERN = `^(?:${[...EU_VAT_ID_FORMATS]
  .map(
    ([prefix, format]) =>
      `${prefix}(?:${format.source.replace(/^\^/u, "").replace(/\$$/u, "")})`,
  )
  .join("|")})$`;

/** `compactVatId` in SQL, for a column named by `column`. */
export const EU_VAT_ID_SQL_COMPACT = (column: string) =>
  `upper(regexp_replace(${column}, '[[:space:].-]', '', 'g'))`;

type ContactTaxIdentifiers = {
  taxId: string | null;
  vatId: string | null;
};

/**
 * A contact's tax and VAT IDs as invoicing reads them and every writer stores
 * them: an EU VAT number in the tax ID field while the VAT ID is empty is the
 * VAT ID. Contacts written before the two fields were separated hold it there
 * until the contact VAT ID repair moves it.
 */
export const contactTaxIdentifiers = ({
  taxId,
  vatId,
}: ContactTaxIdentifiers): ContactTaxIdentifiers =>
  (vatId === null || vatId.trim() === "") &&
  taxId !== null &&
  isWellFormedEuVatId(taxId)
    ? { taxId: null, vatId: taxId }
    : { taxId, vatId };

type ContactTaxIdentifierPatch = {
  stored: ContactTaxIdentifiers;
  taxId: string | null | undefined;
  vatId: string | null | undefined;
};

/**
 * The pair an update writes. The stored pair is read by the rule first, the
 * request's fields then replace it as sent (an explicit clear stays a clear),
 * and only a tax ID the request itself writes is classified again.
 */
export const patchContactTaxIdentifiers = ({
  stored,
  taxId,
  vatId,
}: ContactTaxIdentifierPatch): ContactTaxIdentifiers => {
  const current = contactTaxIdentifiers(stored);
  const next = {
    taxId: taxId === undefined ? current.taxId : taxId,
    vatId: vatId === undefined ? current.vatId : vatId,
  };
  return taxId === undefined ? next : contactTaxIdentifiers(next);
};

/**
 * The number part of business tax IDs outside the EU whose syntax is fixed;
 * any other country needs at least five characters, four of them digits.
 */
const NON_EU_TAX_ID_FORMATS: ReadonlyMap<string, RegExp> = new Map([
  ["GB", UK_VAT_NUMBER],
  ["XI", UK_VAT_NUMBER],
  ["CH", /^E\d{9}(?:MWST|TVA|IVA)?$/u],
  ["NO", /^\d{9}(?:MVA)?$/u],
]);
const GENERIC_TAX_ID_NUMBER = /^(?=(?:\D*\d){4})[0-9A-Z]{5,}$/u;

/**
 * Whether a prefixed business tax ID from outside the EU looks like one, so
 * a prefix with arbitrary characters behind it ("GBAB") never takes an
 * invoice outside the scope of VAT.
 */
export const isWellFormedNonEuTaxId = (vatId: string | null): boolean => {
  const compact = compactVatId(vatId);
  const format =
    NON_EU_TAX_ID_FORMATS.get(compact.slice(0, 2)) ?? GENERIC_TAX_ID_NUMBER;
  return format.test(compact.slice(2));
};

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
  "outside_scope",
  "domestic_rate",
  "no_vat_rate",
  "client_country_unconfirmed",
  "client_vat_id_invalid",
] as const;
export type InvoiceVatReason = (typeof INVOICE_VAT_REASONS)[number];

export type InvoiceVatDecision = {
  vatTreatment: VatTreatment;
  vatRateBps: number;
  reason: InvoiceVatReason;
};

type DecideInvoiceVatOptions = {
  /** Null when the invoice has no seller profile. */
  seller: {
    country: string | null;
    vatId: string | null;
    vatPayer: boolean;
  } | null;
  buyerVatId: string | null;
  buyerVatPayer: boolean | null;
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
const OUTSIDE_SCOPE: InvoiceVatDecision = {
  vatTreatment: "outside_scope",
  vatRateBps: 0,
  reason: "outside_scope",
};

/**
 * The VAT treatment a client's VAT ID implies for a seller with an EU VAT ID:
 * reverse charge for a business in another member state, outside the scope
 * for a business outside the EU, otherwise the domestic rate with the reason.
 */
const crossBorderVat = ({
  seller,
  buyerVatId,
  buyerCountry,
  standardRateBps,
}: DecideInvoiceVatOptions & {
  seller: NonNullable<DecideInvoiceVatOptions["seller"]>;
}): InvoiceVatDecision => {
  const sellerCountry = invoiceSellerCountryOf(seller);
  const sellerState = euVatPrefix(seller.vatId);
  const buyerPrefix = vatIdCountry(buyerVatId);
  if (
    sellerCountry === null ||
    !EU_MEMBER_STATES.has(sellerCountry) ||
    sellerState === null ||
    buyerPrefix === null
  ) {
    return domesticVat(standardRateBps);
  }
  const vatCountry = invoiceCountryForVatPrefix(buyerPrefix);
  if (vatCountry === null) {
    return domesticVat(standardRateBps, "client_country_unconfirmed");
  }
  if (vatCountry === sellerCountry) {
    return domesticVat(standardRateBps);
  }
  if (addressCountry(buyerCountry) !== vatCountry) {
    return domesticVat(standardRateBps, "client_country_unconfirmed");
  }
  if (!EU_MEMBER_STATES.has(vatCountry)) {
    // Outside the EU, including Northern Ireland for services, the place of
    // supply is abroad and the service is outside the scope of VAT, shown by
    // a well-formed business tax ID.
    return isWellFormedNonEuTaxId(buyerVatId)
      ? OUTSIDE_SCOPE
      : domesticVat(standardRateBps, "client_vat_id_invalid");
  }
  // VAT-payer status is separate from taxable-business status: a registered
  // non-payer can still receive cross-border services under reverse charge.
  // A business client in another member state accounts for the VAT itself
  // (Art. 44/196), shown by a VAT ID with that state's syntax.
  return isWellFormedEuVatId(buyerVatId)
    ? {
        vatTreatment: "reverse_charge",
        vatRateBps: 0,
        reason: "reverse_charge",
      }
    : domesticVat(standardRateBps, "client_vat_id_invalid");
};

export const decideInvoiceVat = (
  options: DecideInvoiceVatOptions,
): InvoiceVatDecision => {
  const { seller, buyerCountry } = options;
  if (seller === null) {
    return {
      vatTreatment: "domestic_vat",
      vatRateBps: 0,
      reason: "no_seller_profile",
    };
  }
  // Legal services to a client established outside the EU are supplied where
  // the client is for an EU-established seller, whether a business (Art. 44) or a private person
  // (Art. 59(c)); SK zákon 222/2004 Z. z. § 15 ods. 1 and § 16 ods. 15 and
  // 16 písm. c). The address alone decides; no tax ID is needed.
  const clientCountry = addressCountry(buyerCountry);
  const sellerCountry = invoiceSellerCountryOf(seller);
  if (
    sellerCountry !== null &&
    EU_MEMBER_STATES.has(sellerCountry) &&
    clientCountry !== null &&
    !EU_MEMBER_STATES.has(clientCountry)
  ) {
    return OUTSIDE_SCOPE;
  }
  const crossBorder = crossBorderVat({ ...options, seller });
  // A business client in another member state pays the VAT even when the
  // seller is not a VAT payer: the invoice carries the reverse-charge wording
  // (SK § 72 ods. 2 and § 74 ods. 1 písm. k); CZ § 29 odst. 2 písm. c).
  if (crossBorder.vatTreatment === "reverse_charge") {
    return crossBorder;
  }
  if (!seller.vatPayer) {
    return {
      vatTreatment: "not_vat_payer",
      vatRateBps: 0,
      reason: "seller_not_vat_payer",
    };
  }
  return crossBorder;
};

export type InvoiceBuyerSnapshot = {
  buyerName: string | null;
  buyerRegistrationId: string | null;
  buyerTaxId: string | null;
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
  buyerTaxId: null,
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
  vatId: string | null;
  vatPayer: boolean | null;
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
  const { addresses } = contact;
  const address: BillingAddress | undefined =
    contact.billingAddress?.line1 === undefined
      ? (addresses?.find((entry) => entry.type === "billing") ??
        addresses?.find((entry) => entry.isPrimary) ??
        addresses?.at(0))
      : contact.billingAddress;
  const identifiers = contactTaxIdentifiers({
    taxId: contact.taxId,
    vatId: contact.vatId,
  });
  return {
    buyerName: text(contact.displayName, 512),
    buyerRegistrationId: text(contact.registrationNumber, 64),
    buyerTaxId: text(identifiers.taxId, 64),
    buyerVatId: text(identifiers.vatId, 64),
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
