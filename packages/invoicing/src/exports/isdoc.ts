import { Result } from "better-result";

import { invalidInput, type InvoicingResult } from "../errors";
import type { InvoiceDocumentType, InvoiceParty } from "../types";
import {
  amountText,
  countryCodeOf,
  invoiceDescriptionOf,
  quantityText,
  splitCzechAccountNumber,
  streetOf,
  variableSymbolOf,
  vatPercentText,
  type InvoiceExportRecord,
} from "./record";
import { el, requiredText, text, XML_DECLARATION } from "./xml";

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
    el("PartyIdentification", requiredText("ID", subject.registrationNumber)),
    el("PartyName", requiredText("Name", subject.name)),
    el("PostalAddress", [
      requiredText("StreetName", streetOf(subject)),
      requiredText("BuildingNumber", ""),
      requiredText("CityName", subject.city),
      requiredText("PostalZone", subject.postalCode),
      el("Country", [
        requiredText("IdentificationCode", countryCodeOf(subject.country)),
        requiredText("Name", subject.country),
      ]),
    ]),
    subject.vatId
      ? el("PartyTaxScheme", [
          requiredText("CompanyID", subject.vatId),
          requiredText("TaxScheme", "VAT"),
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
    const unitGross = Math.round(unitNet * (1 + line.vatRateBps / 10_000));
    return el("InvoiceLine", [
      requiredText("ID", String(index + 1)),
      original
        ? el("OriginalDocumentReference", requiredText("LineID", ""), {
            ref: "original",
          })
        : "",
      requiredText("InvoicedQuantity", quantityText(line.quantity), {
        unitCode: line.unit ?? "",
      }),
      requiredText("LineExtensionAmount", amount(line.netAmountMinor)),
      requiredText(
        "LineExtensionAmountTaxInclusive",
        amount(line.grossAmountMinor),
      ),
      requiredText("LineExtensionTaxAmount", amount(line.vatAmountMinor)),
      requiredText("UnitPrice", amount(unitNet)),
      requiredText("UnitPriceTaxInclusive", amount(unitGross)),
      el("ClassifiedTaxCategory", [
        requiredText("Percent", vatPercentText(line.vatRateBps)),
        requiredText("VATCalculationMethod", "0"),
        requiredText(
          "VATApplicable",
          String(vatPayer && line.vatTreatment !== "not_vat_payer"),
        ),
      ]),
      el("Item", requiredText("Description", line.description)),
    ]);
  });
  const subtotals = record.totals.vatBreakdown.map((band) =>
    el("TaxSubTotal", [
      requiredText("TaxableAmount", amount(band.netAmountMinor)),
      requiredText("TaxAmount", amount(band.vatAmountMinor)),
      requiredText("TaxInclusiveAmount", amount(band.grossAmountMinor)),
      requiredText("AlreadyClaimedTaxableAmount", zero),
      requiredText("AlreadyClaimedTaxAmount", zero),
      requiredText("AlreadyClaimedTaxInclusiveAmount", zero),
      requiredText("DifferenceTaxableAmount", amount(band.netAmountMinor)),
      requiredText("DifferenceTaxAmount", amount(band.vatAmountMinor)),
      requiredText(
        "DifferenceTaxInclusiveAmount",
        amount(band.grossAmountMinor),
      ),
      el(
        "TaxCategory",
        requiredText("Percent", vatPercentText(band.vatRateBps)),
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
            requiredText("PaidAmount", amount(totals.grossAmountMinor)),
            requiredText("PaymentMeansCode", "42"),
            el("Details", [
              requiredText("PaymentDueDate", record.dueDate),
              requiredText("ID", account?.account),
              requiredText("BankCode", account?.bankCode),
              requiredText("Name", ""),
              requiredText("IBAN", record.seller.iban),
              requiredText("BIC", record.seller.bic),
              text("VariableSymbol", variableSymbolOf(record)),
            ]),
          ]),
        );
  const body = [
    requiredText("DocumentType", DOCUMENT_TYPE[record.documentType]),
    requiredText("ID", record.number),
    requiredText("UUID", record.id),
    requiredText("IssuingSystem", "Stella"),
    requiredText("IssueDate", record.issueDate),
    record.documentType === "advance"
      ? ""
      : text("TaxPointDate", record.taxableSupplyDate),
    requiredText("VATApplicable", String(vatPayer)),
    requiredText("ElectronicPossibilityAgreementReference", ""),
    text("Note", invoiceDescriptionOf(record)),
    requiredText("LocalCurrencyCode", currency),
    requiredText("CurrRate", "1"),
    requiredText("RefCurrRate", "1"),
    el("AccountingSupplierParty", party(record.seller)),
    el("AccountingCustomerParty", party(record.buyer)),
    original
      ? el(
          "OriginalDocumentReferences",
          el("OriginalDocumentReference", requiredText("ID", original), {
            id: "original",
          }),
        )
      : "",
    el("InvoiceLines", lines),
    el("TaxTotal", [
      ...subtotals,
      requiredText("TaxAmount", amount(totals.vatAmountMinor)),
    ]),
    el("LegalMonetaryTotal", [
      requiredText("TaxExclusiveAmount", amount(totals.netAmountMinor)),
      requiredText("TaxInclusiveAmount", amount(totals.grossAmountMinor)),
      requiredText("AlreadyClaimedTaxExclusiveAmount", zero),
      requiredText("AlreadyClaimedTaxInclusiveAmount", zero),
      requiredText(
        "DifferenceTaxExclusiveAmount",
        amount(totals.netAmountMinor),
      ),
      requiredText(
        "DifferenceTaxInclusiveAmount",
        amount(totals.grossAmountMinor),
      ),
      requiredText("PaidDepositsAmount", zero),
      requiredText("PayableAmount", amount(totals.grossAmountMinor)),
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
      fileName: `${record.number.replace(/[^\w.-]/gu, "_")}.isdoc`,
      content: document(record),
    });
  }
  return Result.ok(files);
};
