import {
  countryCodeOf,
  czechVatBandOf,
  effectiveVatRateBps,
  type InvoiceExportRecord,
  quantityText,
  variableSymbolOf,
} from "./record";

/** A spreadsheet cell: text, a plain number, or an amount in its currency. */
export type InvoiceTableCell =
  | { type: "text"; value: string }
  | { type: "number"; value: number }
  | { type: "amount"; amountMinor: number; currency: string };

export type InvoiceTable = {
  headers: string[];
  rows: InvoiceTableCell[][];
};

export type InvoiceTableLanguage = "cs" | "en";

const textCell = (value: string | null | undefined): InvoiceTableCell => ({
  type: "text",
  value: value ?? "",
});

const numberCell = (value: number): InvoiceTableCell => ({
  type: "number",
  value,
});

const amountCell = (
  amountMinor: number,
  currency: string,
): InvoiceTableCell => ({ type: "amount", amountMinor, currency });

const LABELS = {
  en: {
    number: "Invoice number",
    documentType: "Document type",
    status: "Status",
    matter: "Matter",
    matterReference: "Matter reference",
    buyer: "Client",
    registrationNumber: "Company ID",
    vatId: "VAT ID",
    issueDate: "Issue date",
    taxableSupplyDate: "Taxable supply date",
    dueDate: "Due date",
    paidDate: "Paid on",
    currency: "Currency",
    net: "Net amount",
    vat: "VAT",
    gross: "Total",
    variableSymbol: "Variable symbol",
    originalNumber: "Corrects invoice",
    reference: "Reference",
    position: "Line",
    description: "Description",
    quantity: "Quantity",
    unit: "Unit",
    unitPrice: "Unit price",
    vatRate: "VAT rate %",
    source: "Source",
    date: "Date",
    timekeeper: "Timekeeper",
    documentTypes: {
      invoice: "Invoice",
      advance: "Advance invoice",
      credit_note: "Credit note",
    },
    statuses: {
      finalized: "Issued",
      sent: "Sent",
      paid: "Paid",
      void: "Void",
    },
    sources: { manual: "Manual", time_entry: "Time", expense: "Expense" },
  },
  cs: {
    number: "Číslo faktury",
    documentType: "Typ dokladu",
    status: "Stav",
    matter: "Spis",
    matterReference: "Číslo spisu",
    buyer: "Odběratel",
    registrationNumber: "IČO",
    vatId: "DIČ",
    issueDate: "Datum vystavení",
    taxableSupplyDate: "DUZP",
    dueDate: "Datum splatnosti",
    paidDate: "Zaplaceno",
    currency: "Měna",
    net: "Částka bez DPH",
    vat: "DPH",
    gross: "Celkem",
    variableSymbol: "Variabilní symbol",
    originalNumber: "Opravuje fakturu",
    reference: "Reference",
    position: "Řádek",
    description: "Popis",
    quantity: "Množství",
    unit: "Jednotka",
    unitPrice: "Jednotková cena",
    vatRate: "Sazba DPH %",
    source: "Zdroj",
    date: "Datum",
    timekeeper: "Zpracoval",
    documentTypes: {
      invoice: "Faktura",
      advance: "Zálohová faktura",
      credit_note: "Dobropis",
    },
    statuses: {
      finalized: "Vystaveno",
      sent: "Odesláno",
      paid: "Zaplaceno",
      void: "Stornováno",
    },
    sources: { manual: "Ruční", time_entry: "Výkaz", expense: "Náklad" },
  },
} as const;

/** One row per invoice, with its parties, dates and totals. */
export const buildInvoiceSummaryTable = (
  records: readonly InvoiceExportRecord[],
  lang: InvoiceTableLanguage,
): InvoiceTable => {
  const t = LABELS[lang];
  return {
    headers: [
      t.number,
      t.documentType,
      t.status,
      t.matter,
      t.matterReference,
      t.buyer,
      t.registrationNumber,
      t.vatId,
      t.issueDate,
      t.taxableSupplyDate,
      t.dueDate,
      t.paidDate,
      t.currency,
      t.net,
      t.vat,
      t.gross,
      t.variableSymbol,
      t.originalNumber,
      t.reference,
    ],
    rows: records.map((record) => [
      textCell(record.number),
      textCell(t.documentTypes[record.documentType]),
      textCell(t.statuses[record.status]),
      textCell(record.matter.name),
      textCell(record.matter.reference),
      textCell(record.buyer.name),
      textCell(record.buyer.registrationNumber),
      textCell(record.buyer.vatId),
      textCell(record.issueDate),
      textCell(record.taxableSupplyDate),
      textCell(record.dueDate),
      textCell(record.paidDate),
      textCell(record.currency),
      amountCell(record.totals.netAmountMinor, record.currency),
      amountCell(record.totals.vatAmountMinor, record.currency),
      amountCell(record.totals.grossAmountMinor, record.currency),
      textCell(variableSymbolOf(record)),
      textCell(record.originalNumber),
      textCell(record.reference),
    ]),
  };
};

/** One row per invoice line, with the work date and timekeeper behind it. */
export const buildInvoiceLinesTable = (
  records: readonly InvoiceExportRecord[],
  lang: InvoiceTableLanguage,
): InvoiceTable => {
  const t = LABELS[lang];
  return {
    headers: [
      t.number,
      t.position,
      t.date,
      t.description,
      t.quantity,
      t.unit,
      t.unitPrice,
      t.vatRate,
      t.net,
      t.vat,
      t.gross,
      t.currency,
      t.source,
      t.timekeeper,
    ],
    rows: records.flatMap((record) =>
      record.lines.map((line, index) => [
        textCell(record.number),
        numberCell(index + 1),
        textCell(line.date),
        textCell(line.description),
        numberCell(Number(quantityText(line.quantity))),
        textCell(line.unit),
        amountCell(line.unitPriceMinor ?? line.netAmountMinor, record.currency),
        numberCell(effectiveVatRateBps(line) / 100),
        amountCell(line.netAmountMinor, record.currency),
        amountCell(line.vatAmountMinor, record.currency),
        amountCell(line.grossAmountMinor, record.currency),
        textCell(record.currency),
        textCell(t.sources[line.source]),
        textCell(line.timekeeper?.name),
      ]),
    ),
  };
};

const EU_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
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
]);

/** `YYYY-MM-DD` as the `D.M.YYYY` text the ESO9 import template expects. */
const eso9Date = (date: string | null): string => {
  if (date === null) {
    return "";
  }
  const [year = "", month = "", day = ""] = date.split("-");
  return `${day}.${month}.${year}`;
};

/**
 * The issued-invoice import sheet of the ESO9 ERP: home-currency amounts by
 * VAT band and supply type, plus the foreign-currency total for an invoice in
 * another currency (whose home amounts ESO9 fills from its rate list).
 */
export const buildEso9Table = (
  records: readonly InvoiceExportRecord[],
): InvoiceTable => ({
  headers: [
    "Číslo",
    "Varsym",
    "Date (UTC)",
    "Odp/UplatDPH",
    "Datum splatnosti",
    "Kč snížená",
    "DPH snížená",
    "Kč základní",
    "DPH základní",
    "Kč 2 snížená",
    "DPH 2 snížená",
    "Kč Vývoz EU",
    "Kč Vývoz mimo EU",
    "Firma (Jméno)",
    "Celkem",
    "Celkem valuta",
    "Měna",
    "Kurz",
    "DIČ",
    "IČ",
  ],
  rows: records.map((record) => {
    const home = record.currency === record.seller.homeCurrency;
    const bands = {
      reduced: { base: 0, vat: 0 },
      secondReduced: { base: 0, vat: 0 },
      basic: { base: 0, vat: 0 },
    };
    let exportEu = 0;
    let exportOther = 0;
    const buyerCountry = countryCodeOf(record.buyer.country);
    // ESO9 is a Czech ERP: a seller stored without a country code is Czech.
    const sellerCountry = countryCodeOf(record.seller.country) ?? "CZ";
    const foreignBuyer =
      buyerCountry !== null && buyerCountry !== sellerCountry;
    for (const line of record.lines) {
      // A supply abroad at no Czech VAT is an export. The sheet has no column
      // for a domestic one (reverse charge, exempt); it counts in Celkem only.
      if (foreignBuyer && effectiveVatRateBps(line) === 0) {
        if (EU_COUNTRIES.has(buyerCountry)) {
          exportEu += line.netAmountMinor;
        } else {
          exportOther += line.netAmountMinor;
        }
        continue;
      }
      const band = czechVatBandOf(effectiveVatRateBps(line));
      if (band !== "zero") {
        bands[band].base += line.netAmountMinor;
        bands[band].vat += line.vatAmountMinor;
      }
    }
    const homeAmount = (value: number): InvoiceTableCell =>
      home ? amountCell(value, record.currency) : textCell("");
    return [
      textCell(record.number),
      textCell(variableSymbolOf(record)),
      textCell(eso9Date(record.issueDate)),
      textCell(eso9Date(record.taxableSupplyDate ?? record.issueDate)),
      textCell(eso9Date(record.dueDate)),
      homeAmount(bands.reduced.base),
      homeAmount(bands.reduced.vat),
      homeAmount(bands.basic.base),
      homeAmount(bands.basic.vat),
      homeAmount(bands.secondReduced.base),
      homeAmount(bands.secondReduced.vat),
      homeAmount(exportEu),
      homeAmount(exportOther),
      textCell(record.buyer.name),
      homeAmount(record.totals.grossAmountMinor),
      home
        ? textCell("")
        : amountCell(record.totals.grossAmountMinor, record.currency),
      textCell(record.currency),
      textCell(""),
      textCell(record.buyer.vatId),
      textCell(record.buyer.registrationNumber),
    ];
  }),
});
