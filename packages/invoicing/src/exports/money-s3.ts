import { Result } from "better-result";

import { invalidInput, type InvoicingResult } from "../errors";
import type { InvoiceParty } from "../types";
import {
  amountText,
  clip,
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

// Money S3 XML data exchange (MoneyData/SeznamFaktVyd), per the vendor's
// published XSD (__Faktura.xsd). Its elements are `xs:all`, so order is free;
// lengths are not: a document number holds 10 characters, a description 50.

const MAX_DOCUMENT_NUMBER = 10;

type Band = { base: number; vat: number; rateBps: number | null };

const emptyBand = (): Band => ({ base: 0, vat: 0, rateBps: null });

const bandsOf = (record: InvoiceExportRecord) => {
  const bands = {
    zero: emptyBand(),
    reduced: emptyBand(),
    secondReduced: emptyBand(),
    basic: emptyBand(),
  };
  for (const line of record.lines) {
    const band = bands[czechVatBandOf(effectiveVatRateBps(line))];
    band.base += line.netAmountMinor;
    band.vat += line.vatAmountMinor;
    band.rateBps ??= effectiveVatRateBps(line);
  }
  return bands;
};

const address = (name: string, party: InvoiceParty) =>
  el(name, [
    text("Ulice", streetOf(party)),
    text("Misto", party.city),
    text("PSC", party.postalCode),
    text("KodStatu", countryCodeOf(party.country)),
  ]);

const firm = (party: InvoiceParty): string[] => [
  text("ObchNazev", party.name),
  address("ObchAdresa", party),
  text("FaktNazev", party.name),
  text("ICO", party.registrationNumber),
  text("DIC", party.vatId),
  address("FaktAdresa", party),
  text("Nazev", party.name),
  text("PlatceDPH", party.vatId ? "1" : "0"),
];

const invoice = (record: InvoiceExportRecord): string => {
  const { currency } = record;
  const amount = (value: number) => amountText(value, currency);
  const bands = bandsOf(record);
  const description = clip(
    invoiceDescriptionOf(record) ?? `${record.matter.name} ${record.number}`,
    50,
  );
  return el("FaktVyd", [
    text("Doklad", record.number),
    text("Popis", description),
    text("Vystaveno", record.issueDate),
    text("DatUcPr", record.taxableSupplyDate ?? record.issueDate),
    text(
      "PlnenoDPH",
      record.documentType === "advance" ? null : record.taxableSupplyDate,
    ),
    text("Splatno", record.dueDate),
    text("Uhrazeno", record.paidDate),
    text("VarSymbol", variableSymbolOf(record)),
    text("PuvDoklad", record.originalNumber && clip(record.originalNumber, 50)),
    text("Druh", record.documentType === "advance" ? "L" : "N"),
    text("Dobropis", record.documentType === "credit_note" ? "1" : "0"),
    text("Uhrada", "převodem"),
    text(
      "SazbaDPH1",
      bands.reduced.rateBps === null
        ? null
        : vatPercentText(bands.reduced.rateBps),
    ),
    text(
      "SazbaDPH2",
      bands.basic.rateBps === null ? null : vatPercentText(bands.basic.rateBps),
    ),
    el("SouhrnDPH", [
      text("Zaklad0", amount(bands.zero.base)),
      text("Zaklad5", amount(bands.reduced.base)),
      text("Zaklad22", amount(bands.basic.base)),
      text("DPH5", amount(bands.reduced.vat)),
      text("DPH22", amount(bands.basic.vat)),
      bands.secondReduced.rateBps === null
        ? ""
        : el(
            "SeznamDalsiSazby",
            el("DalsiSazba", [
              text("HladinaDPH", "1"),
              text("Sazba", vatPercentText(bands.secondReduced.rateBps)),
              text("Zaklad", amount(bands.secondReduced.base)),
              text("DPH", amount(bands.secondReduced.vat)),
            ]),
          ),
    ]),
    text("Celkem", amount(record.totals.grossAmountMinor)),
    text("Poznamka", record.notes),
    el("DodOdb", firm(record.buyer)),
    el(
      "SeznamPolozek",
      record.lines.map((line, index) => {
        const unitPrice = line.unitPriceMinor ?? line.netAmountMinor;
        return el("Polozka", [
          text("Popis", clip(line.description, 50)),
          text(
            "Poznamka",
            Array.from(line.description).length > 50 ? line.description : null,
          ),
          text("PocetMJ", quantityText(line.quantity)),
          text("SazbaDPH", vatPercentText(effectiveVatRateBps(line))),
          text("Cena", amount(unitPrice)),
          el("SouhrnDPH", [
            text("Zaklad_MJ", amount(unitPrice)),
            text("Zaklad", amount(line.netAmountMinor)),
            text("DPH", amount(line.vatAmountMinor)),
          ]),
          text("CenaTyp", "0"),
          text("Poradi", String(index + 1)),
          text("CenaPoSleve", "1"),
        ]);
      }),
    ),
  ]);
};

/**
 * Issued invoices as a Money S3 import file. Money S3 books in the company's
 * home currency and needs home-currency totals, which a foreign-currency
 * invoice cannot supply without an exchange rate, so those are refused.
 */
export const buildMoneyS3Xml = (
  records: readonly InvoiceExportRecord[],
): InvoicingResult<string> => {
  if (records.length === 0) {
    return invalidInput("There are no issued invoices to export");
  }
  for (const record of records) {
    if (record.currency !== record.seller.homeCurrency) {
      return invalidInput(
        `Invoice ${record.number} is in ${record.currency}; Money S3 needs home-currency (${record.seller.homeCurrency}) amounts and an exchange rate`,
      );
    }
    if (Array.from(record.number).length > MAX_DOCUMENT_NUMBER) {
      return invalidInput(
        `Invoice number ${record.number} is longer than the ${MAX_DOCUMENT_NUMBER} characters Money S3 accepts`,
      );
    }
  }
  const root = el("MoneyData", el("SeznamFaktVyd", records.map(invoice)));
  return Result.ok(`${XML_DECLARATION}${root}\n`);
};
