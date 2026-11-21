import { Result } from "better-result";

import { invalidInput, type InvoicingResult } from "../errors";
import { countryCodeOf, type InvoiceExportRecord } from "./record";
import { serializeUblFiles } from "./ubl";

const CUSTOMIZATION_ID =
  "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0";
const PROFILE_ID = "urn:fdc:peppol.eu:2017:poacc:billing:01:1.0";
const SLOVAK_TAX_ID = /^\d{10}$/u;

const refusal = (record: InvoiceExportRecord, reason: string) =>
  invalidInput(`Invoice ${record.number}: ${reason}`);

// EN 16931 BT-27/BT-44 names, BT-40/BT-55 countries and at least one line
// (BG-25) are mandatory; an empty value would serialize a non-conforming file.
const partyRefusal = (record: InvoiceExportRecord): string | null => {
  if (countryCodeOf(record.seller.country) !== "SK") {
    return "Peppol (Slovakia) is available only for sellers in Slovakia";
  }
  // The Slovak mandate covers domestic supplies (zákon 385/2025 Z. z.); a
  // foreign buyer is reached through its own channel, not a 0245 endpoint.
  if (countryCodeOf(record.buyer.country) === null) {
    return "buyer country is required";
  }
  if (countryCodeOf(record.buyer.country) !== "SK") {
    return "Peppol (Slovakia) covers buyers in Slovakia; the buyer country is not SK";
  }
  if (!record.seller.name.trim()) {
    return "seller name is required";
  }
  if (!record.buyer.name.trim()) {
    return "buyer name is required";
  }
  // EN 16931 BR-CO-26: the seller carries an identifier, VAT ID or legal
  // registration ID; the IČO is the one every Slovak seller has, whatever the
  // VAT category (an outside-scope invoice may carry no VAT IDs).
  if (!record.seller.registrationNumber?.trim()) {
    return "seller IČO (registration number) is required";
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
  return null;
};

const documentRefusal = (record: InvoiceExportRecord): string | null => {
  if (record.documentType === "advance") {
    return "advance invoices are not supported; issue invoice type 380 for each received payment and deduct it on the final invoice";
  }
  if (record.currency !== "EUR") {
    return "Peppol (Slovakia) currently supports EUR invoices only";
  }
  if (record.lines.length === 0) {
    return "an e-invoice needs at least one line";
  }
  if (record.documentType === "credit_note") {
    return !record.originalNumber || !record.originalIssueDate
      ? "a credit note needs the corrected invoice number and issue date"
      : null;
  }
  return record.dueDate ? null : "a payment due date is required";
};

const lineRefusal = (record: InvoiceExportRecord): string | null => {
  const categories = new Set(record.lines.map((line) => line.vatTreatment));
  if (categories.has("not_vat_payer")) {
    return "non-VAT-payer sellers may not issue Slovak e-invoices";
  }
  // EN 16931 BR-AE-03: a reverse-charge invoice names the buyer's VAT ID
  // (BT-48) or legal registration ID (BT-47); the Peppol endpoint is neither.
  if (
    categories.has("reverse_charge") &&
    !record.buyer.vatId?.trim() &&
    !record.buyer.registrationNumber?.trim()
  ) {
    return "a reverse-charge invoice needs the buyer's IČ DPH or IČO";
  }
  if (categories.has("outside_scope") && categories.size > 1) {
    return "an outside-scope (O) line cannot be mixed with other VAT categories; export it on a separate invoice";
  }
  // EN 16931 carries one exemption reason per VAT breakdown (BG-23).
  const exemptionBases = new Set(
    record.lines.flatMap((line) =>
      line.vatTreatment === "exempt"
        ? [line.exemptionReason?.trim() ?? ""]
        : [],
    ),
  );
  if (exemptionBases.has("")) {
    return "each exempt line needs its stored statutory exemption basis";
  }
  // The rate is the one the supply was taxed at (20 % and 10 % before 2025),
  // so a correction of an older supply keeps its historical rate.
  return exemptionBases.size > 1
    ? "exempt lines with different exemption bases cannot share one VAT breakdown; export them on separate invoices"
    : null;
};

const validate = (record: InvoiceExportRecord): string | null =>
  partyRefusal(record) ?? documentRefusal(record) ?? lineRefusal(record);

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
      omitPaymentDueDate: true,
    }),
  );
};
