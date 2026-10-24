import { Result } from "better-result";

import { invalidInput, type InvoicingResult } from "../errors";
import type { InvoiceDocumentType, InvoiceParty } from "../types";
import {
  amountText,
  countryCodeOf,
  effectiveVatRateBps,
  exportFileNamer,
  invoiceDescriptionOf,
  type InvoiceExportRecord,
  quantityText,
  splitCzechAccountNumber,
  streetOf,
  variableSymbolOf,
  vatPercentText,
} from "./record";
import { el, mandatoryText, text, XML_DECLARATION } from "./xml";

// ISDOC 6.0.2, the Czech e-invoice standard (http://isdoc.cz/namespace/2013).
// One document per file; accounting programs such as ABRA Gen, POHODA and
// Money import it directly. Element order follows the schema's sequences.

const NAMESPACE = "http://isdoc.cz/namespace/2013";

const DOCUMENT_TYPE: Record<InvoiceDocumentType, string> = {
  invoice: "1",
  credit_note: "2",
  // A non-tax advance request ("nedaňový zálohový list").
  advance: "4",
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const party = (subject: InvoiceParty): string =>
  el("Party", [
    el("PartyIdentification", mandatoryText("ID", subject.registrationNumber)),
    el("PartyName", mandatoryText("Name", subject.name)),
    el("PostalAddress", [
      mandatoryText("StreetName", streetOf(subject)),
      mandatoryText("BuildingNumber", ""),
      mandatoryText("CityName", subject.city),
      mandatoryText("PostalZone", subject.postalCode),
      el("Country", [
        mandatoryText("IdentificationCode", countryCodeOf(subject.country)),
        mandatoryText("Name", subject.country),
      ]),
    ]),
    subject.vatId
      ? el("PartyTaxScheme", [
          mandatoryText("CompanyID", subject.vatId),
          mandatoryText("TaxScheme", "VAT"),
        ])
      : "",
  ]);

const document = (record: InvoiceExportRecord): string => {
  const { currency } = record;
  const amount = (value: number) => amountText(value, currency);
  const vatPayer = Boolean(record.seller.vatId);
  const zero = amount(0);
  const original =
    record.documentType === "credit_note" && record.originalNumber !== null
      ? record.originalNumber
      : null;
  const account = splitCzechAccountNumber(record.seller.accountNumber);
  const lines = record.lines.map((line, index) => {
    const unitNet = line.unitPriceMinor ?? line.netAmountMinor;
    const unitGross = Math.round(
      unitNet * (1 + effectiveVatRateBps(line) / 10_000),
    );
    return el("InvoiceLine", [
      mandatoryText("ID", String(index + 1)),
      original
        ? el("OriginalDocumentReference", mandatoryText("LineID", ""), {
            ref: "original",
          })
        : "",
      mandatoryText("InvoicedQuantity", quantityText(line.quantity), {
        unitCode: line.unit ?? "",
      }),
      mandatoryText("LineExtensionAmount", amount(line.netAmountMinor)),
      mandatoryText(
        "LineExtensionAmountTaxInclusive",
        amount(line.grossAmountMinor),
      ),
      mandatoryText("LineExtensionTaxAmount", amount(line.vatAmountMinor)),
      mandatoryText("UnitPrice", amount(unitNet)),
      mandatoryText("UnitPriceTaxInclusive", amount(unitGross)),
      el("ClassifiedTaxCategory", [
        mandatoryText("Percent", vatPercentText(effectiveVatRateBps(line))),
        mandatoryText("VATCalculationMethod", "0"),
        mandatoryText(
          "VATApplicable",
          String(vatPayer && line.vatTreatment !== "not_vat_payer"),
        ),
      ]),
      el("Item", mandatoryText("Description", line.description)),
    ]);
  });
  // One subtotal per rate the lines are charged at, so a reverse-charge or
  // exempt line sits in the 0 % band its line states, not its stored rate.
  const bands = new Map<
    number,
    {
      vatRateBps: number;
      netAmountMinor: number;
      vatAmountMinor: number;
      grossAmountMinor: number;
    }
  >();
  for (const line of record.lines) {
    const rate = effectiveVatRateBps(line);
    const band = bands.get(rate) ?? {
      vatRateBps: rate,
      netAmountMinor: 0,
      vatAmountMinor: 0,
      grossAmountMinor: 0,
    };
    band.netAmountMinor += line.netAmountMinor;
    band.vatAmountMinor += line.vatAmountMinor;
    band.grossAmountMinor += line.grossAmountMinor;
    bands.set(rate, band);
  }
  const subtotals = [...bands.values()].map((band) =>
    el("TaxSubTotal", [
      mandatoryText("TaxableAmount", amount(band.netAmountMinor)),
      mandatoryText("TaxAmount", amount(band.vatAmountMinor)),
      mandatoryText("TaxInclusiveAmount", amount(band.grossAmountMinor)),
      mandatoryText("AlreadyClaimedTaxableAmount", zero),
      mandatoryText("AlreadyClaimedTaxAmount", zero),
      mandatoryText("AlreadyClaimedTaxInclusiveAmount", zero),
      mandatoryText("DifferenceTaxableAmount", amount(band.netAmountMinor)),
      mandatoryText("DifferenceTaxAmount", amount(band.vatAmountMinor)),
      mandatoryText(
        "DifferenceTaxInclusiveAmount",
        amount(band.grossAmountMinor),
      ),
      el(
        "TaxCategory",
        mandatoryText("Percent", vatPercentText(band.vatRateBps)),
      ),
    ]),
  );
  const totals = record.totals;
  const payable =
    record.documentType === "credit_note" || !record.dueDate
      ? ""
      : el(
          "PaymentMeans",
          el("Payment", [
            mandatoryText("PaidAmount", amount(totals.grossAmountMinor)),
            mandatoryText("PaymentMeansCode", "42"),
            el("Details", [
              mandatoryText("PaymentDueDate", record.dueDate),
              mandatoryText("ID", account?.account),
              mandatoryText("BankCode", account?.bankCode),
              mandatoryText("Name", ""),
              mandatoryText("IBAN", record.seller.iban),
              mandatoryText("BIC", record.seller.bic),
              text("VariableSymbol", variableSymbolOf(record)),
            ]),
          ]),
        );
  const body = [
    mandatoryText("DocumentType", DOCUMENT_TYPE[record.documentType]),
    mandatoryText("ID", record.number),
    mandatoryText("UUID", record.id),
    mandatoryText("IssuingSystem", "Stella"),
    mandatoryText("IssueDate", record.issueDate),
    record.documentType === "advance"
      ? ""
      : text("TaxPointDate", record.taxableSupplyDate),
    mandatoryText("VATApplicable", String(vatPayer)),
    mandatoryText("ElectronicPossibilityAgreementReference", ""),
    text("Note", invoiceDescriptionOf(record)),
    mandatoryText("LocalCurrencyCode", currency),
    mandatoryText("CurrRate", "1"),
    mandatoryText("RefCurrRate", "1"),
    el("AccountingSupplierParty", party(record.seller)),
    el("AccountingCustomerParty", party(record.buyer)),
    original
      ? el(
          "OriginalDocumentReferences",
          el("OriginalDocumentReference", mandatoryText("ID", original), {
            id: "original",
          }),
        )
      : "",
    el("InvoiceLines", lines),
    el("TaxTotal", [
      ...subtotals,
      mandatoryText("TaxAmount", amount(totals.vatAmountMinor)),
    ]),
    el("LegalMonetaryTotal", [
      mandatoryText("TaxExclusiveAmount", amount(totals.netAmountMinor)),
      mandatoryText("TaxInclusiveAmount", amount(totals.grossAmountMinor)),
      mandatoryText("AlreadyClaimedTaxExclusiveAmount", zero),
      mandatoryText("AlreadyClaimedTaxInclusiveAmount", zero),
      mandatoryText(
        "DifferenceTaxExclusiveAmount",
        amount(totals.netAmountMinor),
      ),
      mandatoryText(
        "DifferenceTaxInclusiveAmount",
        amount(totals.grossAmountMinor),
      ),
      mandatoryText("PaidDepositsAmount", zero),
      mandatoryText("PayableAmount", amount(totals.grossAmountMinor)),
    ]),
    payable,
  ];
  return `${XML_DECLARATION}${el("Invoice", body, {
    xmlns: NAMESPACE,
    version: "6.0.2",
  })}\n`;
};

/**
 * One ISDOC file per invoice, keyed by file name. ISDOC states amounts in
 * the issuer's local currency; an invoice in another currency would need an
 * exchange rate stella does not store, so it is refused.
 */
export const buildIsdocFiles = (
  records: readonly InvoiceExportRecord[],
): InvoicingResult<{ fileName: string; content: string }[]> => {
  if (records.length === 0) {
    return invalidInput("There are no issued invoices to export");
  }
  const fileName = exportFileNamer("isdoc");
  const files: { fileName: string; content: string }[] = [];
  for (const record of records) {
    if (record.currency !== record.seller.homeCurrency) {
      return invalidInput(
        `Invoice ${record.number} is in ${record.currency}; ISDOC needs local-currency (${record.seller.homeCurrency}) amounts and an exchange rate`,
      );
    }
    if (!UUID_PATTERN.test(record.id)) {
      return invalidInput(`Invoice ${record.number} has no UUID identifier`);
    }
    files.push({
      fileName: fileName(record.number),
      content: document(record),
    });
  }
  return Result.ok(files);
};
