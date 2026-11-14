import { panic, Result } from "better-result";

import { invalidInput, type InvoicingResult } from "../errors";
import type { InvoiceParty, VatTreatment } from "../types";
import {
  amountText,
  countryCodeOf,
  effectiveVatRateBps,
  exportFileNamer,
  exportMattersOf,
  invoiceDescriptionOf,
  type InvoiceExportLine,
  type InvoiceExportRecord,
  quantityText,
  variableSymbolOf,
  vatPercentText,
} from "./record";
import { el, text, XML_DECLARATION } from "./xml";

// UBL 2.1 following the European e-invoicing standard EN 16931 (CEN core
// invoice model). Invoices and advance invoices are `Invoice` documents; a
// credit note is a `CreditNote` with positive amounts that references the
// invoice it corrects. Element order follows the OASIS UBL 2.1 schemas.

const NS = {
  invoice: "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2",
  creditNote: "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
};

const CUSTOMIZATION_ID = "urn:cen.eu:en16931:2017";

export type UblSerializationOptions = {
  customizationId: string;
  profileId?: string;
  endpointScheme?: string;
  buyerReferenceFallback?: boolean;
  requireIban?: boolean;
  paymentMeansCode?: "30" | "58";
  omitVatIds?: boolean;
  exemptionReasonCodes?: boolean;
  /** Peppol BIS carries the due date at document level only (BT-9). */
  omitPaymentDueDate?: boolean;
};

/** UNCL 5305 VAT category of a line. */
const vatCategoryOf = (
  vatTreatment: VatTreatment,
  vatRateBps: number,
): "S" | "Z" | "E" | "AE" | "O" => {
  switch (vatTreatment) {
    case "domestic_vat":
      return vatRateBps > 0 ? "S" : "Z";
    case "exempt":
      return "E";
    case "reverse_charge":
      return "AE";
    // A service whose place of supply is outside the EU.
    case "outside_scope":
      return "O";
    case "not_vat_payer":
      return "O";
    default: {
      vatTreatment satisfies never;
      return panic("Unknown VAT treatment");
    }
  }
};

const EXEMPTION_REASON: Partial<Record<string, string>> = {
  E: "Exempt from VAT",
  AE: "Reverse charge",
  O: "Not subject to VAT",
};

/** UN/ECE Recommendation 20 unit: hours for time, otherwise "one". */
const unitCodeOf = (unit: string | null): string =>
  unit !== null && /^(h|hod|hours?)$/iu.test(unit.trim()) ? "HUR" : "C62";

type TaxCategoryOptions = {
  name: "cac:TaxCategory" | "cac:ClassifiedTaxCategory";
  category: string;
  vatRateBps: number;
  withReason: boolean;
  exemptionReason?: string | null;
  exemptionReasonCodes?: boolean;
};

const taxCategory = ({
  name,
  category,
  vatRateBps,
  withReason,
  exemptionReason = null,
  exemptionReasonCodes = false,
}: TaxCategoryOptions): string => {
  let reasonCode = "";
  if (withReason && exemptionReasonCodes && category === "AE") {
    reasonCode = text("cbc:TaxExemptionReasonCode", "VATEX-EU-AE");
  } else if (withReason && exemptionReasonCodes && category === "O") {
    reasonCode = text("cbc:TaxExemptionReasonCode", "VATEX-EU-O");
  }
  let reason = "";
  if (withReason && category === "E") {
    reason = text(
      "cbc:TaxExemptionReason",
      exemptionReason?.trim() || EXEMPTION_REASON["E"],
    );
  } else if (withReason) {
    reason = text("cbc:TaxExemptionReason", EXEMPTION_REASON[category]);
  }
  return el(name, [
    text("cbc:ID", category),
    category === "O" ? "" : text("cbc:Percent", vatPercentText(vatRateBps)),
    reasonCode,
    reason,
    el("cac:TaxScheme", text("cbc:ID", "VAT")),
  ]);
};

const party = (
  subject: InvoiceParty,
  options: UblSerializationOptions,
): string => {
  const country = countryCodeOf(subject.country);
  return el("cac:Party", [
    options.endpointScheme
      ? text("cbc:EndpointID", subject.taxId, {
          schemeID: options.endpointScheme,
        })
      : "",
    el("cac:PartyName", text("cbc:Name", subject.name)),
    el("cac:PostalAddress", [
      text("cbc:StreetName", subject.addressLine1),
      text("cbc:AdditionalStreetName", subject.addressLine2),
      text("cbc:CityName", subject.city),
      text("cbc:PostalZone", subject.postalCode),
      el("cac:Country", text("cbc:IdentificationCode", country)),
    ]),
    subject.vatId && !options.omitVatIds
      ? el("cac:PartyTaxScheme", [
          text("cbc:CompanyID", subject.vatId),
          el("cac:TaxScheme", text("cbc:ID", "VAT")),
        ])
      : "",
    el("cac:PartyLegalEntity", [
      text("cbc:RegistrationName", subject.name),
      text("cbc:CompanyID", subject.registrationNumber),
    ]),
  ]);
};

type Mode = "invoice" | "creditNote";

type LineOptions = {
  item: InvoiceExportLine;
  index: number;
  currency: string;
  mode: Mode;
  serialization: UblSerializationOptions;
};

const line = ({
  item,
  index,
  currency,
  mode,
  serialization,
}: LineOptions): string => {
  const amount = (value: number) =>
    text(
      "cbc:LineExtensionAmount",
      amountText(mode === "creditNote" ? Math.abs(value) : value, currency),
      { currencyID: currency },
    );
  // EN 16931 forbids a negative price; a negative invoice line (a discount)
  // carries a negative quantity at the positive price instead.
  const net =
    mode === "creditNote" ? Math.abs(item.netAmountMinor) : item.netAmountMinor;
  const unitPrice = Math.abs(item.unitPriceMinor ?? item.netAmountMinor);
  const quantity = quantityText(item.quantity).replace(/^-/u, "");
  const signedQuantity = net < 0 ? `-${quantity}` : quantity;
  const category = vatCategoryOf(item.vatTreatment, effectiveVatRateBps(item));
  const lineName =
    mode === "creditNote" ? "cac:CreditNoteLine" : "cac:InvoiceLine";
  const quantityName =
    mode === "creditNote" ? "cbc:CreditedQuantity" : "cbc:InvoicedQuantity";
  return el(lineName, [
    text("cbc:ID", String(index + 1)),
    text(quantityName, signedQuantity, { unitCode: unitCodeOf(item.unit) }),
    amount(item.netAmountMinor),
    item.date
      ? el("cac:InvoicePeriod", [
          text("cbc:StartDate", item.date),
          text("cbc:EndDate", item.date),
        ])
      : "",
    el("cac:Item", [
      text("cbc:Name", Array.from(item.description).slice(0, 100).join("")),
      taxCategory({
        name: "cac:ClassifiedTaxCategory",
        category,
        vatRateBps: effectiveVatRateBps(item),
        withReason: false,
        exemptionReason: item.exemptionReason,
        exemptionReasonCodes: serialization.exemptionReasonCodes ?? false,
      }),
    ]),
    el(
      "cac:Price",
      text("cbc:PriceAmount", amountText(unitPrice, currency), {
        currencyID: currency,
      }),
    ),
  ]);
};

const document = (
  record: InvoiceExportRecord,
  options: UblSerializationOptions,
): string => {
  const mode: Mode =
    record.documentType === "credit_note" ? "creditNote" : "invoice";
  const { currency } = record;
  const sign = mode === "creditNote" ? -1 : 1;
  const money = (name: string, value: number) =>
    text(name, amountText(sign * value, currency), { currencyID: currency });
  const totals = record.totals;
  const subtotals = new Map<
    string,
    { category: string; vatRateBps: number; base: number; vat: number }
  >();
  for (const item of record.lines) {
    const category = vatCategoryOf(
      item.vatTreatment,
      effectiveVatRateBps(item),
    );
    const key = `${category}:${effectiveVatRateBps(item)}`;
    const current = subtotals.get(key) ?? {
      category,
      vatRateBps: effectiveVatRateBps(item),
      base: 0,
      vat: 0,
    };
    current.base += item.netAmountMinor;
    current.vat += item.vatAmountMinor;
    subtotals.set(key, current);
  }
  const variableSymbol = variableSymbolOf(record);
  const payment =
    mode === "creditNote" ||
    (!record.seller.iban &&
      (options.requireIban || !record.seller.accountNumber))
      ? ""
      : el("cac:PaymentMeans", [
          text("cbc:PaymentMeansCode", options.paymentMeansCode ?? "30"),
          options.omitPaymentDueDate
            ? ""
            : text("cbc:PaymentDueDate", record.dueDate),
          text("cbc:PaymentID", variableSymbol),
          el("cac:PayeeFinancialAccount", [
            text("cbc:ID", record.seller.iban ?? record.seller.accountNumber),
            record.seller.bic
              ? el(
                  "cac:FinancialInstitutionBranch",
                  text("cbc:ID", record.seller.bic),
                )
              : "",
          ]),
        ]);
  const body = [
    text("cbc:CustomizationID", options.customizationId),
    text("cbc:ProfileID", options.profileId),
    text("cbc:ID", record.number),
    text("cbc:IssueDate", record.issueDate),
    // The two schemas place the tax point date differently.
    ...(mode === "invoice"
      ? [
          text("cbc:DueDate", record.dueDate),
          text(
            "cbc:InvoiceTypeCode",
            record.documentType === "advance" ? "386" : "380",
          ),
          text("cbc:Note", invoiceDescriptionOf(record)),
          record.documentType === "advance"
            ? ""
            : text("cbc:TaxPointDate", record.taxableSupplyDate),
        ]
      : [
          text("cbc:TaxPointDate", record.taxableSupplyDate),
          text("cbc:CreditNoteTypeCode", "381"),
          text("cbc:Note", invoiceDescriptionOf(record)),
        ]),
    text("cbc:DocumentCurrencyCode", currency),
    text(
      "cbc:BuyerReference",
      record.reference ??
        (exportMattersOf(record)
          .flatMap((matter) => matter.reference ?? [])
          .join(", ") ||
          (options.buyerReferenceFallback ? record.number : null)),
    ),
    record.originalNumber
      ? el(
          "cac:BillingReference",
          el("cac:InvoiceDocumentReference", [
            text("cbc:ID", record.originalNumber),
            text("cbc:IssueDate", record.originalIssueDate),
          ]),
        )
      : "",
    el("cac:AccountingSupplierParty", party(record.seller, options)),
    el("cac:AccountingCustomerParty", party(record.buyer, options)),
    payment,
    el("cac:TaxTotal", [
      money("cbc:TaxAmount", totals.vatAmountMinor),
      ...[...subtotals.values()].map((subtotal) =>
        el("cac:TaxSubtotal", [
          money("cbc:TaxableAmount", subtotal.base),
          money("cbc:TaxAmount", subtotal.vat),
          taxCategory({
            name: "cac:TaxCategory",
            category: subtotal.category,
            vatRateBps: subtotal.vatRateBps,
            withReason: true,
            exemptionReason:
              record.lines.find(
                (itemLine) =>
                  vatCategoryOf(
                    itemLine.vatTreatment,
                    effectiveVatRateBps(itemLine),
                  ) === subtotal.category &&
                  effectiveVatRateBps(itemLine) === subtotal.vatRateBps,
              )?.exemptionReason ?? null,
            exemptionReasonCodes: options.exemptionReasonCodes ?? false,
          }),
        ]),
      ),
    ]),
    el("cac:LegalMonetaryTotal", [
      money("cbc:LineExtensionAmount", totals.netAmountMinor),
      money("cbc:TaxExclusiveAmount", totals.netAmountMinor),
      money("cbc:TaxInclusiveAmount", totals.grossAmountMinor),
      money("cbc:PayableAmount", totals.grossAmountMinor),
    ]),
    ...record.lines.map((item, index) =>
      line({ item, index, currency, mode, serialization: options }),
    ),
  ];
  const root = mode === "creditNote" ? "CreditNote" : "Invoice";
  return `${XML_DECLARATION}${el(root, body, {
    xmlns: mode === "creditNote" ? NS.creditNote : NS.invoice,
    "xmlns:cac": NS.cac,
    "xmlns:cbc": NS.cbc,
  })}\n`;
};

/** One UBL (EN 16931) document per invoice, keyed by file name. */
export const buildUblFiles = (
  records: readonly InvoiceExportRecord[],
): InvoicingResult<{ fileName: string; content: string }[]> => {
  if (records.length === 0) {
    return invalidInput("There are no issued invoices to export");
  }
  // EN 16931 requires both parties' country codes (BR-09, BR-11).
  for (const record of records) {
    for (const [role, subject] of [
      ["seller", record.seller],
      ["buyer", record.buyer],
    ] as const) {
      if (countryCodeOf(subject.country) === null) {
        return invalidInput(
          `Invoice ${record.number} has no two-letter country code for the ${role}; EN 16931 requires one`,
        );
      }
    }
  }
  const fileName = exportFileNamer("xml");
  return Result.ok(
    records.map((record) => ({
      fileName: fileName(record.number),
      content: document(record, { customizationId: CUSTOMIZATION_ID }),
    })),
  );
};

/** Serialize already-validated records with a stricter UBL business profile. */
export const serializeUblFiles = (
  records: readonly InvoiceExportRecord[],
  options: UblSerializationOptions,
): { fileName: string; content: string }[] => {
  const fileName = exportFileNamer("xml");
  return records.map((record) => ({
    fileName: fileName(record.number),
    content: document(record, {
      ...options,
      omitVatIds:
        options.omitVatIds ||
        record.lines.some(
          (itemLine) => itemLine.vatTreatment === "outside_scope",
        ),
    }),
  }));
};
