import { parseDecimalToken } from "@stll/agent-input/numeric-token";

import type { EInvoice } from "./e-invoice";

/**
 * Code lists a structured invoice writes its units and identifier schemes
 * in, read for display. The invoice keeps the codes verbatim; only how they
 * are named on screen and in text comes from here. A code missing from a
 * list is shown as the file writes it.
 */

/** The units named in words, translated per language with a plural. */
export const E_INVOICE_UNIT_NAMES = [
  "unit",
  "hour",
  "day",
  "week",
  "month",
  "year",
] as const;

export type EInvoiceUnitName = (typeof E_INVOICE_UNIT_NAMES)[number];

/**
 * UN/ECE Recommendation 20 codes named in words. C62 ("one") and H87
 * (piece) are how EN 16931 invoices count items, EA how older ones do.
 */
const NAMED_UNITS: ReadonlyMap<string, EInvoiceUnitName> = new Map([
  ["C62", "unit"],
  ["H87", "unit"],
  ["EA", "unit"],
  ["HUR", "hour"],
  ["DAY", "day"],
  ["WEE", "week"],
  ["MON", "month"],
  ["ANN", "year"],
]);

/** UN/ECE Recommendation 20 codes written with their SI symbol. */
const UNIT_SYMBOLS: ReadonlyMap<string, string> = new Map([
  ["GRM", "g"],
  ["KGM", "kg"],
  ["TNE", "t"],
  ["MMT", "mm"],
  ["CMT", "cm"],
  ["MTR", "m"],
  ["KMT", "km"],
  ["MTK", "m²"],
  ["MTQ", "m³"],
  ["MLT", "ml"],
  ["LTR", "l"],
  ["SEC", "s"],
  ["MIN", "min"],
  ["KWH", "kWh"],
]);

export type EInvoiceUnit =
  | { readonly type: "named"; readonly name: EInvoiceUnitName }
  | { readonly type: "symbol"; readonly symbol: string }
  | { readonly type: "code"; readonly code: string };

/** How a unit code is written: in words, as a symbol, or as the code. */
export const eInvoiceUnit = (code: string): EInvoiceUnit => {
  const normalized = code.trim().toUpperCase();
  const name = NAMED_UNITS.get(normalized);
  if (name !== undefined) {
    return { type: "named", name };
  }
  const symbol = UNIT_SYMBOLS.get(normalized);
  return symbol === undefined
    ? { type: "code", code }
    : { type: "symbol", symbol };
};

/**
 * The number a quantity literal states, for choosing a plural form; null
 * when the literal is not a plain decimal number.
 */
export const eInvoiceQuantityCount = (quantity: string): number | null => {
  const count = parseDecimalToken(quantity.trim());
  return count.isOk() ? count.value : null;
};

/**
 * Electronic address schemes (EAS) that name a VAT number: the 99xx codes
 * by country, and the Italian and Finnish ones in the ISO 6523 range. An
 * endpoint in one of them is the party's VAT number.
 */
const VAT_ADDRESS_SCHEMES: ReadonlySet<string> = new Set([
  "0211",
  "0213",
  "9906",
  "9910",
  "9914",
  "9920",
  ...Array.from({ length: 9953 - 9922 + 1 }, (_, index) =>
    String(9922 + index),
  ),
  "9957",
]);

/** Whether an electronic address scheme names a VAT number. */
export const isVatAddressScheme = (scheme: string | null): boolean =>
  scheme !== null && VAT_ADDRESS_SCHEMES.has(scheme.trim());

/**
 * ISO 6523 identifier schemes, as invoices write them for registration and
 * other party identifiers, by the name the identifier goes by. Names are
 * proper names and are not translated.
 */
const IDENTIFIER_SCHEME_NAMES: ReadonlyMap<string, string> = new Map([
  ["0002", "SIRENE"],
  ["0007", "Organisationsnummer"],
  ["0009", "SIRET"],
  ["0037", "LY-tunnus"],
  ["0060", "DUNS"],
  ["0088", "GLN"],
  ["0106", "KvK"],
  ["0151", "ABN"],
  ["0184", "CVR"],
  ["0190", "OIN"],
  ["0192", "Organisasjonsnummer"],
  ["0199", "LEI"],
  ["0204", "Leitweg-ID"],
  ["0208", "KBO-BCE"],
]);

type Identifier = EInvoice["seller"]["identifiers"][number];

/**
 * How an identifier's scheme is named beside it:
 * - `none`: the kind says it all (a VAT or tax id's scheme only says VAT).
 * - `named`: a known scheme, named by what the identifier goes by ("GLN").
 * - `code`: an unknown scheme, written as the file writes it.
 */
export type EInvoiceIdentifierScheme =
  | { readonly type: "none" }
  | { readonly type: "named"; readonly name: string }
  | { readonly type: "code"; readonly code: string };

export const eInvoiceIdentifierScheme = ({
  kind,
  scheme,
}: Pick<Identifier, "kind" | "scheme">): EInvoiceIdentifierScheme => {
  if (scheme === null || kind === "vat" || kind === "tax") {
    return { type: "none" };
  }
  const name = IDENTIFIER_SCHEME_NAMES.get(scheme.trim());
  return name === undefined
    ? { type: "code", code: scheme }
    : { type: "named", name };
};
