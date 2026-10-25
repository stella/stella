import { Result } from "better-result";

import { invalidInput, type InvoicingResult } from "../errors";
import { countryCodeOf, type InvoiceExportRecord } from "./record";
import { serializeUblFiles } from "./ubl";

const CUSTOMIZATION_ID =
  "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";
const PROFILE_ID = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";
const SLOVAK_TAX_ID = /^\d{10}$/u;
const SLOVAK_VAT_RATES = new Set([500, 1900, 2300]);

const refusal = (record: InvoiceExportRecord, reason: string) =>
  invalidInput(`Invoice ${record.number}: ${reason}`);

const validate = (record: InvoiceExportRecord): string | null => {
  if (countryCodeOf(record.seller.country) !== "SK") {
    return "Peppol (Slovakia) is available only for sellers in Slovakia";
  }
  if (record.documentType === "advance") {
    return "advance invoices are not supported; issue invoice type 380 for each received payment and deduct it on the final invoice";
  }
  if (record.currency !== "EUR") {
    return "Peppol (Slovakia) currently supports EUR invoices only";
  }
  if (!SLOVAK_TAX_ID.test(record.seller.taxId?.trim() ?? "")) {
    return "seller DIČ (tax ID) must be a 10-digit Slovak DIČ";
  }
  if (!SLOVAK_TAX_ID.test(record.buyer.taxId?.trim() ?? "")) {
    return "buyer DIČ (tax ID) must be a 10-digit Slovak DIČ";
  }
  if (!record.seller.iban?.trim()) {
    return "seller IBAN is required for Peppol payment instructions";
  }
  if (!record.seller.vatId?.trim()) {
    return "the seller must be a VAT payer with an IČ DPH; non-VAT-payer sellers may not issue Slovak e-invoices";
  }
  if (record.documentType === "credit_note") {
    if (!record.originalNumber || !record.originalIssueDate) {
      return "a credit note needs the corrected invoice number and issue date";
    }
  } else if (!record.dueDate) {
    return "a payment due date is required";
  }

  const categories = new Set(record.lines.map((line) => line.vatTreatment));
  if (categories.has("not_vat_payer")) {
    return "non-VAT-payer sellers may not issue Slovak e-invoices";
  }
  if (categories.has("outside_scope") && categories.size > 1) {
    return "an outside-scope (O) line cannot be mixed with other VAT categories; export it on a separate invoice";
  }
  for (const line of record.lines) {
    if (
      line.vatTreatment === "domestic_vat" &&
      line.vatRateBps !== 0 &&
      !SLOVAK_VAT_RATES.has(line.vatRateBps)
    ) {
      return `domestic VAT rate ${String(line.vatRateBps / 100)}% is not a Slovak 23%, 19%, or 5% rate`;
    }
    if (line.vatTreatment === "exempt" && !line.exemptionReason?.trim()) {
      return "each exempt line needs its stored statutory exemption basis";
    }
  }
  return null;
};

/** Peppol BIS Billing 3.0 UBL for invoices issued by Slovak VAT payers. */
export const buildPeppolSkFiles = (
  records: readonly InvoiceExportRecord[],
): InvoicingResult<{ fileName: string; content: string }[]> => {
  if (records.length === 0) {
    return invalidInput("There are no issued invoices to export");
  }
  for (const record of records) {
    const reason = validate(record);
    if (reason !== null) {
      return refusal(record, reason);
    }
  }
  return Result.ok(
    serializeUblFiles(records, {
      customizationId: CUSTOMIZATION_ID,
      profileId: PROFILE_ID,
      endpointScheme: "0245",
      buyerReferenceFallback: true,
      requireIban: true,
      paymentMeansCode: "58",
      exemptionReasonCodes: true,
    }),
  );
};
