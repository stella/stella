import type { EInvoice } from "@stll/api-contract/e-invoice";

import {
  addressLines,
  amountInCurrency,
  at,
  attributeOf,
  capLines,
  childrenOf,
  documentTypeFromUnCode,
  type EmbeddedInvoiceFile,
  joined,
  type ParsedEInvoice,
  textAt,
  textOf,
} from "@/api/lib/files/e-invoice-nodes";
import type { DocumentXmlNode } from "@/api/lib/files/xml-document-package";

// OASIS UBL 2.1 Invoice and CreditNote as bound to EN 16931 by
// CEN/TS 16931-3-2 (Peppol BIS Billing 3.0, XRechnung UBL).

const party = (node: DocumentXmlNode | undefined): EInvoice["seller"] => {
  const address = at(node, "PostalAddress");
  const legal = at(node, "PartyLegalEntity");
  const legalId = at(legal, "CompanyID");
  const endpoint = at(node, "EndpointID");
  return {
    name:
      textAt(node, "PartyName", "Name") ??
      textOf(at(legal, "RegistrationName")),
    identifiers: [
      ...childrenOf(node, "PartyTaxScheme").flatMap((scheme) => {
        const value = textAt(scheme, "CompanyID");
        const schemeId = textAt(scheme, "TaxScheme", "ID");
        if (value === null) {
          return [];
        }
        return [
          {
            kind: schemeId === "VAT" ? ("vat" as const) : ("tax" as const),
            scheme: schemeId,
            value,
          },
        ];
      }),
      ...(textOf(legalId) === null
        ? []
        : [
            {
              kind: "registration" as const,
              scheme: attributeOf(legalId, "schemeID"),
              value: textOf(legalId) ?? "",
            },
          ]),
      ...childrenOf(node, "PartyIdentification").flatMap((identification) => {
        const id = at(identification, "ID");
        const value = textOf(id);
        return value === null
          ? []
          : [
              {
                kind: "other" as const,
                scheme: attributeOf(id, "schemeID"),
                value,
              },
            ];
      }),
      ...(textOf(endpoint) === null
        ? []
        : [
            {
              kind: "other" as const,
              scheme: attributeOf(endpoint, "schemeID"),
              value: textOf(endpoint) ?? "",
            },
          ]),
    ],
    address: addressLines(
      textAt(address, "StreetName"),
      textAt(address, "AdditionalStreetName"),
      textAt(address, "AddressLine", "Line"),
      joined(" ", textAt(address, "PostalZone"), textAt(address, "CityName")),
      textAt(address, "CountrySubentity"),
      textAt(address, "Country", "IdentificationCode"),
    ),
  };
};

export const readUblInvoice = (root: DocumentXmlNode): ParsedEInvoice => {
  const isCreditNote = root.localName === "CreditNote";
  const typeCode = textAt(
    root,
    isCreditNote ? "CreditNoteTypeCode" : "InvoiceTypeCode",
  );
  const currency = textAt(root, "DocumentCurrencyCode");
  const lines = childrenOf(
    root,
    isCreditNote ? "CreditNoteLine" : "InvoiceLine",
  );
  const taxTotals = childrenOf(root, "TaxTotal");
  const total = at(root, "LegalMonetaryTotal");
  const payments = childrenOf(root, "PaymentMeans");
  const documentType = documentTypeFromUnCode(typeCode);
  const invoice: EInvoice = {
    documentType:
      isCreditNote && documentType === "invoice" ? "creditNote" : documentType,
    typeCode,
    number: textAt(root, "ID"),
    issueDate: textAt(root, "IssueDate"),
    taxPointDate: textAt(root, "TaxPointDate"),
    dueDate:
      textAt(root, "DueDate") ??
      payments
        .map((payment) => textAt(payment, "PaymentDueDate"))
        .find((date) => date !== null) ??
      null,
    currency,
    seller: party(at(root, "AccountingSupplierParty", "Party")),
    buyer: party(at(root, "AccountingCustomerParty", "Party")),
    lines: capLines(
      lines.map((line) => {
        const quantity =
          at(line, "InvoicedQuantity") ?? at(line, "CreditedQuantity");
        const item = at(line, "Item");
        return {
          id: textAt(line, "ID"),
          description: textAt(item, "Name") ?? textAt(item, "Description"),
          quantity: textOf(quantity),
          unitCode: attributeOf(quantity, "unitCode"),
          unitPrice: textAt(line, "Price", "PriceAmount"),
          vatRate: textAt(item, "ClassifiedTaxCategory", "Percent"),
          vatCategory: textAt(item, "ClassifiedTaxCategory", "ID"),
          netAmount: textAt(line, "LineExtensionAmount"),
        };
      }),
    ),
    lineCount: lines.length,
    vatBreakdown: taxTotals.flatMap((taxTotal) =>
      childrenOf(taxTotal, "TaxSubtotal").map((subtotal) => ({
        rate: textAt(subtotal, "TaxCategory", "Percent"),
        category: textAt(subtotal, "TaxCategory", "ID"),
        taxableAmount: textAt(subtotal, "TaxableAmount"),
        taxAmount: textAt(subtotal, "TaxAmount"),
        exemptionReason: textAt(subtotal, "TaxCategory", "TaxExemptionReason"),
      })),
    ),
    totals: {
      netAmount: textAt(total, "TaxExclusiveAmount"),
      taxAmount: amountInCurrency(
        taxTotals.flatMap((taxTotal) => childrenOf(taxTotal, "TaxAmount")),
        currency,
      ),
      grossAmount: textAt(total, "TaxInclusiveAmount"),
      prepaidAmount: textAt(total, "PrepaidAmount"),
      payableAmount: textAt(total, "PayableAmount"),
    },
    payments: payments.map((payment) => {
      const account = at(payment, "PayeeFinancialAccount");
      return {
        meansCode: textAt(payment, "PaymentMeansCode"),
        dueDate: textAt(payment, "PaymentDueDate"),
        amount: null,
        iban: textAt(account, "ID"),
        bic: textAt(account, "FinancialInstitutionBranch", "ID"),
        accountNumber: null,
        bankCode: null,
        reference: textAt(payment, "PaymentID"),
      };
    }),
    notes: [
      ...childrenOf(root, "Note"),
      ...childrenOf(root, "PaymentTerms").flatMap((terms) =>
        childrenOf(terms, "Note"),
      ),
    ].flatMap((note) => textOf(note) ?? []),
  };
  return {
    version: textAt(root, "CustomizationID") ?? textAt(root, "UBLVersionID"),
    invoices: [invoice],
    embedded: childrenOf(root, "AdditionalDocumentReference").flatMap(
      (reference): EmbeddedInvoiceFile[] => {
        const object = at(
          reference,
          "Attachment",
          "EmbeddedDocumentBinaryObject",
        );
        const base64 = object?.text ?? "";
        if (base64.trim() === "") {
          return [];
        }
        return [
          {
            fileName:
              attributeOf(object, "filename") ??
              textAt(reference, "ID") ??
              "attachment",
            description:
              textAt(reference, "DocumentDescription") ??
              textAt(reference, "ID"),
            base64,
          },
        ];
      },
    ),
  };
};
