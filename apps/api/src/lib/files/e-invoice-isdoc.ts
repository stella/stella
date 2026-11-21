import type { EInvoice } from "@stll/api-contract/e-invoice";

import {
  addressLines,
  at,
  attributeOf,
  capLines,
  childrenOf,
  joined,
  type ParsedEInvoice,
  textAt,
  textOf,
} from "@/api/lib/files/e-invoice-nodes";
import type { DocumentXmlNode } from "@/api/lib/files/xml-document-package";

// ISDOC 6.0.2 (Ministry of the Interior of the Czech Republic), element names
// per the published `isdoc-invoice-6.0.2.xsd`. Amounts are in the local
// currency, which is the currency shown; the optional foreign-currency
// amounts (`*Curr` elements) are not read.

// ISDOC DocumentType codes: 1 invoice, 2 credit note, 3 debit note, 4 advance
// invoice, 5 tax document for a received advance, 6 credit note to it,
// 7 simplified invoice.
const documentTypeOf = (code: string | null): EInvoice["documentType"] => {
  switch (code) {
    case "1":
    case "7":
      return "invoice";
    case "2":
    case "6":
      return "creditNote";
    case "3":
      return "debitNote";
    case "4":
    case "5":
      return "advance";
    default:
      return "other";
  }
};

const party = (node: DocumentXmlNode | undefined): EInvoice["seller"] => {
  const address = at(node, "PostalAddress");
  const taxSchemes = childrenOf(node, "PartyTaxScheme");
  return {
    name: textAt(node, "PartyName", "Name"),
    identifiers: [
      ...childrenOf(node, "PartyIdentification").flatMap((identification) => {
        const value = textAt(identification, "ID");
        return value === null
          ? []
          : [{ kind: "registration" as const, scheme: null, value }];
      }),
      ...taxSchemes.flatMap((scheme) => {
        const value = textAt(scheme, "CompanyID");
        const name = textAt(scheme, "TaxScheme");
        if (value === null) {
          return [];
        }
        return [
          name === "VAT"
            ? { kind: "vat" as const, scheme: name, value }
            : { kind: "tax" as const, scheme: name, value },
        ];
      }),
    ],
    address: addressLines(
      joined(
        " ",
        textAt(address, "StreetName"),
        textAt(address, "BuildingNumber"),
      ),
      joined(" ", textAt(address, "PostalZone"), textAt(address, "CityName")),
      textAt(address, "Country", "Name") ??
        textAt(address, "Country", "IdentificationCode"),
    ),
  };
};

export const readIsdocInvoice = (root: DocumentXmlNode): ParsedEInvoice => {
  const typeCode = textAt(root, "DocumentType");
  const lines = childrenOf(at(root, "InvoiceLines"), "InvoiceLine");
  const taxTotal = at(root, "TaxTotal");
  const total = at(root, "LegalMonetaryTotal");
  const payments = childrenOf(at(root, "PaymentMeans"), "Payment");
  const invoice: EInvoice = {
    documentType: documentTypeOf(typeCode),
    typeCode,
    number: textAt(root, "ID"),
    issueDate: textAt(root, "IssueDate"),
    taxPointDate: textAt(root, "TaxPointDate"),
    dueDate:
      payments
        .map((payment) => textAt(payment, "Details", "PaymentDueDate"))
        .find((date) => date !== null) ?? null,
    currency: textAt(root, "LocalCurrencyCode"),
    seller: party(at(root, "AccountingSupplierParty", "Party")),
    buyer: party(at(root, "AccountingCustomerParty", "Party")),
    lines: capLines(
      lines.map((line) => {
        const quantity = at(line, "InvoicedQuantity");
        return {
          id: textAt(line, "ID"),
          description: textAt(line, "Item", "Description"),
          quantity: textOf(quantity),
          unitCode: attributeOf(quantity, "unitCode"),
          unitPrice: textAt(line, "UnitPrice"),
          vatRate: textAt(line, "ClassifiedTaxCategory", "Percent"),
          vatCategory: null,
          netAmount: textAt(line, "LineExtensionAmount"),
        };
      }),
    ),
    lineCount: lines.length,
    vatBreakdown: childrenOf(taxTotal, "TaxSubTotal").map((subtotal) => ({
      rate: textAt(subtotal, "TaxCategory", "Percent"),
      category: null,
      taxableAmount: textAt(subtotal, "TaxableAmount"),
      taxAmount: textAt(subtotal, "TaxAmount"),
      exemptionReason: null,
    })),
    totals: {
      netAmount: textAt(total, "TaxExclusiveAmount"),
      taxAmount: textAt(taxTotal, "TaxAmount"),
      grossAmount: textAt(total, "TaxInclusiveAmount"),
      prepaidAmount: textAt(total, "PaidDepositsAmount"),
      payableAmount: textAt(total, "PayableAmount"),
    },
    payments: payments.map((payment) => {
      const details = at(payment, "Details");
      return {
        meansCode: textAt(payment, "PaymentMeansCode"),
        dueDate: textAt(details, "PaymentDueDate"),
        amount: textAt(payment, "PaidAmount"),
        iban: textAt(details, "IBAN"),
        bic: textAt(details, "BIC"),
        accountNumber: textAt(details, "ID"),
        bankCode: textAt(details, "BankCode"),
        reference: textAt(details, "VariableSymbol"),
      };
    }),
    notes: childrenOf(root, "Note").flatMap((note) => textOf(note) ?? []),
  };
  return {
    version: attributeOf(root, "version"),
    invoices: [invoice],
    embedded: [],
  };
};
