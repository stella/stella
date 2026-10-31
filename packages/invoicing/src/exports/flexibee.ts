import { Result } from "better-result";

import { invalidInput, type InvoicingResult } from "../errors";
import type { InvoiceDocumentType, InvoiceParty } from "../types";
import {
  amountText,
  countryCodeOf,
  czechVatBandOf,
  effectiveVatRateBps,
  invoiceDescriptionOf,
  type InvoiceExportRecord,
  quantityText,
  streetOf,
  variableSymbolOf,
  vatPercentText,
} from "./record";
import { el, text, XML_DECLARATION } from "./xml";

// ABRA Flexi (FlexiBee) "winstrom" XML. Records carry `ext:` identifiers so a
// repeated import updates the same invoice and company instead of duplicating
// them. Document type codes are FlexiBee's defaults; a company that renamed
// its types maps them on import.

const EXT = "ext:STELLA";

const DOCUMENT_TYPE: Record<InvoiceDocumentType, string> = {
  invoice: "code:FAKTURA",
  advance: "code:ZALOHA",
  credit_note: "code:DOBROPIS",
};

const VAT_BAND: Record<ReturnType<typeof czechVatBandOf>, string> = {
  zero: "typSzbDph.dphOsv",
  reduced: "typSzbDph.dphSniz",
  secondReduced: "typSzbDph.dphSniz2",
  basic: "typSzbDph.dphZakl",
};

/** A stable key for the buyer: its IČO, else VAT ID, else the invoice. */
const buyerKey = (record: InvoiceExportRecord): string => {
  const id =
    record.buyer.registrationNumber?.trim() ||
    record.buyer.vatId?.trim() ||
    `invoice-${record.id}`;
  return `${EXT}:company:${id.replace(/[^\w.-]/gu, "_")}`;
};

/** The country as a code reference ("code:CZ"), when it is a code already. */
const countryRefOf = (country: string | undefined): string | null => {
  const code = countryCodeOf(country);
  return code === null ? null : `code:${code}`;
};

const partyFields = (party: InvoiceParty) => [
  text("ulice", streetOf(party)),
  text("mesto", party.city),
  text("psc", party.postalCode),
  text("stat", countryRefOf(party.country)),
  text("ic", party.registrationNumber),
  text("dic", party.vatId),
];

const company = (record: InvoiceExportRecord): string =>
  el("adresar", [
    text("id", buyerKey(record)),
    text("nazev", record.buyer.name),
    ...partyFields(record.buyer),
    text("platceDph", record.buyer.vatId ? "true" : "false"),
  ]);

const invoice = (record: InvoiceExportRecord): string => {
  const { currency } = record;
  const home = currency === record.seller.homeCurrency;
  const amount = (value: number) => amountText(value, currency);
  return el("faktura-vydana", [
    text("id", `${EXT}:invoice:${record.id}`),
    text("kod", record.number),
    text("typDokl", DOCUMENT_TYPE[record.documentType]),
    text("datVyst", record.issueDate),
    text("datSplat", record.dueDate),
    text(
      "duzpPuv",
      record.documentType === "advance" ? null : record.taxableSupplyDate,
    ),
    text(
      "duzpUcto",
      record.documentType === "advance" ? null : record.taxableSupplyDate,
    ),
    text("datUcto", record.taxableSupplyDate ?? record.issueDate),
    text("firma", buyerKey(record)),
    text("nazFirmy", record.buyer.name),
    ...partyFields(record.buyer),
    text("varSym", variableSymbolOf(record)),
    text("popis", invoiceDescriptionOf(record)),
    text(
      "poznam",
      record.originalNumber && `Opravuje doklad ${record.originalNumber}`,
    ),
    text("mena", `code:${currency}`),
    text("bezPolozek", "false"),
    el(
      "polozkyDokladu",
      record.lines.map((line, index) =>
        el("faktura-vydana-polozka", [
          text("id", `${EXT}:invoice:${record.id}:line:${index + 1}`),
          text("nazev", line.description),
          text("mnozMj", quantityText(line.quantity)),
          text("szbDph", vatPercentText(effectiveVatRateBps(line))),
          text(
            "typSzbDphK",
            VAT_BAND[czechVatBandOf(effectiveVatRateBps(line))],
          ),
          text("cenaMj", amount(line.unitPriceMinor ?? line.netAmountMinor)),
          text("typCenyDphK", "typCeny.bezDph"),
          ...(home
            ? [
                text("sumZkl", amount(line.netAmountMinor)),
                text("sumDph", amount(line.vatAmountMinor)),
                text("sumCelkem", amount(line.grossAmountMinor)),
              ]
            : []),
        ]),
      ),
      { removeAll: "true" },
    ),
  ]);
};

/** Issued invoices, with their buyers, as one ABRA Flexi import file. */
export const buildFlexibeeXml = (
  records: readonly InvoiceExportRecord[],
): InvoicingResult<string> => {
  if (records.length === 0) {
    return invalidInput("There are no issued invoices to export");
  }
  const companies = new Map<string, string>();
  for (const record of records) {
    companies.set(buyerKey(record), company(record));
  }
  const root = el(
    "winstrom",
    [...companies.values(), ...records.map(invoice)],
    { version: "1.0" },
  );
  return Result.ok(`${XML_DECLARATION}${root}\n`);
};
