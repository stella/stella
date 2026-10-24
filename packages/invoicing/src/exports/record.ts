import {
  type CentsAmount,
  currencyMinorUnitDigits,
  toMajorUnits,
} from "@stll/money";

import type {
  InvoiceDocumentType,
  InvoiceParty,
  InvoiceTotals,
  VatTreatment,
} from "../types";

/** Where an exported line came from, so e-billing formats can type it. */
export type InvoiceExportLineSource = "manual" | "time_entry" | "expense";

/**
 * One invoice line as an export file carries it. Amounts are signed minor
 * units: a credit note's lines are negative.
 */
export type InvoiceExportLine = {
  position: number;
  description: string;
  /** Decimal string, as stored (`numeric(18, 4)`); null on a legacy total. */
  quantity: string | null;
  unit: string | null;
  unitPriceMinor: CentsAmount | null;
  netAmountMinor: CentsAmount;
  vatAmountMinor: CentsAmount;
  grossAmountMinor: CentsAmount;
  vatRateBps: number;
  vatTreatment: VatTreatment;
  source: InvoiceExportLineSource;
  /** The day the work was done or the expense incurred, `YYYY-MM-DD`. */
  date: string | null;
  timekeeper: { id: string; name: string } | null;
  taskCode: string | null;
  activityCode: string | null;
  expenseCode: string | null;
};

export type InvoiceExportSeller = InvoiceParty & {
  iban?: string;
  bic?: string;
  accountNumber?: string;
  /** The currency the seller keeps its books in. */
  homeCurrency: string;
};

/** One issued invoice, advance invoice or credit note, ready to serialize. */
export type InvoiceExportRecord = {
  id: string;
  number: string;
  documentType: InvoiceDocumentType;
  originalNumber: string | null;
  status: "finalized" | "sent" | "paid" | "void";
  issueDate: string;
  taxableSupplyDate: string | null;
  dueDate: string | null;
  /** `YYYY-MM-DD` of the payment, when the invoice is paid. */
  paidDate: string | null;
  currency: string;
  reference: string | null;
  notes: string | null;
  matter: { id: string; name: string; reference: string | null };
  seller: InvoiceExportSeller;
  buyer: InvoiceParty;
  lines: InvoiceExportLine[];
  totals: InvoiceTotals;
};

/**
 * A stored amount as the plain decimal an accounting file carries: a point,
 * no grouping, the currency's own number of decimals.
 */
export const amountText = (amountMinor: number, currency: string): string =>
  toMajorUnits({ amountCents: amountMinor, currency }).toFixed(
    currencyMinorUnitDigits(currency),
  );

/** `numeric(18, 4)` text without trailing zeros: "1.5000" reads "1.5". */
export const quantityText = (quantity: string | null): string => {
  if (quantity === null) {
    return "1";
  }
  let trimmed = quantity;
  if (trimmed.includes(".")) {
    while (trimmed.endsWith("0")) {
      trimmed = trimmed.slice(0, -1);
    }
    if (trimmed.endsWith(".")) {
      trimmed = trimmed.slice(0, -1);
    }
  }
  return trimmed === "" || trimmed === "-0" ? "0" : trimmed;
};

/**
 * The rate VAT is charged at on a line: only domestic VAT charges any, so an
 * exempt, reverse-charge, out-of-scope or non-payer line reads 0 whatever
 * rate it stores.
 */
export const effectiveVatRateBps = (
  line: Pick<InvoiceExportLine, "vatRateBps" | "vatTreatment">,
): number => (line.vatTreatment === "domestic_vat" ? line.vatRateBps : 0);

/** The VAT rate as a whole or decimal percent: 2100 bps reads "21". */
export const vatPercentText = (vatRateBps: number): string =>
  String(vatRateBps / 100);

/**
 * The variable symbol Czech bank payments match on: the reference when it is
 * already one (1–10 digits), else the invoice number's digits when they fit.
 */
export const variableSymbolOf = (
  record: Pick<InvoiceExportRecord, "number" | "reference">,
): string | null => {
  if (record.reference !== null && /^\d{1,10}$/u.test(record.reference)) {
    return record.reference;
  }
  const digits = record.number.replace(/\D/gu, "").replace(/^0+(?=\d)/u, "");
  return digits.length >= 1 && digits.length <= 10 ? digits : null;
};

/** The text that describes the invoice as a whole, if any. */
export const invoiceDescriptionOf = (
  record: Pick<InvoiceExportRecord, "reference" | "notes">,
): string | null => {
  const text = record.notes?.trim() || record.reference?.trim() || "";
  return text === "" ? null : text;
};

/**
 * A Czech domestic account number split into account and bank code:
 * "19-2000145399/0800" reads `{ account: "19-2000145399", bankCode: "0800" }`.
 */
export const splitCzechAccountNumber = (
  accountNumber: string | undefined,
): { account: string; bankCode: string } | null => {
  const match = accountNumber
    ?.replace(/\s/gu, "")
    .match(/^((?:\d{1,6}-)?\d{2,10})\/(\d{4})$/u);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { account: match[1], bankCode: match[2] };
};

/** Two-letter country code, if the stored country already is one. */
export const countryCodeOf = (country: string | undefined): string | null => {
  const code = country?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/u.test(code) ? code : null;
};

/** Text clipped to a field's maximum length, by code point. */
export const clip = (value: string, maxLength: number): string => {
  const chars = Array.from(value);
  return chars.length <= maxLength ? value : chars.slice(0, maxLength).join("");
};

/** The address as one street line, as Czech accounting forms ask for it. */
export const streetOf = (party: InvoiceParty): string =>
  [party.addressLine1, party.addressLine2]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part !== "")
    .join(", ");

/** VAT rate classes the Czech accounting programs bucket amounts into. */
export type CzechVatBand = "zero" | "reduced" | "secondReduced" | "basic";

/**
 * The band a rate belongs to under Czech VAT: 21 % basic; 12 % (2024 on) and
 * 15 % (before) reduced; 10 % the second reduced rate before 2024.
 */
export const czechVatBandOf = (vatRateBps: number): CzechVatBand => {
  if (vatRateBps <= 0) {
    return "zero";
  }
  if (vatRateBps >= 2000) {
    return "basic";
  }
  if (vatRateBps <= 1000) {
    return "secondReduced";
  }
  return "reduced";
};

/**
 * A file name per invoice number, unique within one export. Numbers that
 * sanitise to the same name (FV/1 and FV_1), or differ only in case, get a
 * numeric suffix instead of overwriting each other in the archive.
 */
export const exportFileNamer = (extension: string) => {
  const taken = new Set<string>();
  return (number: string): string => {
    const base = number.replace(/[^\w.-]/gu, "_");
    let name = `${base}.${extension}`;
    for (let suffix = 2; taken.has(name.toLowerCase()); suffix += 1) {
      name = `${base}-${String(suffix)}.${extension}`;
    }
    taken.add(name.toLowerCase());
    return name;
  };
};
