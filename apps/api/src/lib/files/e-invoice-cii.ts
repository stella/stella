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
  statedValues,
  textAt,
  textOf,
} from "@/api/lib/files/e-invoice-nodes";
import type { DocumentXmlNode } from "@/api/lib/files/xml-document-package";

// UN/CEFACT Cross Industry Invoice D16B as bound to EN 16931 by
// CEN/TS 16931-3-3 (Factur-X / ZUGFeRD XML, XRechnung CII).

// UNTDID 2379 format 102 is a calendar date written CCYYMMDD.
const CALENDAR_DATE = /^(\d{4})(\d{2})(\d{2})$/u;

const dateOf = (node: DocumentXmlNode | undefined): string | null => {
  const value = at(node, "DateTimeString") ?? at(node, "DateString");
  const text = textOf(value);
  if (text === null) {
    return null;
  }
  if (attributeOf(value, "format") !== "102") {
    return text;
  }
  const match = CALENDAR_DATE.exec(text);
  const year = match?.[1];
  const month = match?.[2];
  const day = match?.[3];
  return year !== undefined && month !== undefined && day !== undefined
    ? `${year}-${month}-${day}`
    : text;
};

// UNTDID 1153 scheme ids on a tax registration: VA is a VAT id, FC a tax number.
const taxIdentifierKind = (scheme: string | null) =>
  scheme === "VA" ? ("vat" as const) : ("tax" as const);

const party = (node: DocumentXmlNode | undefined): EInvoice["seller"] => {
  const address = at(node, "PostalTradeAddress");
  const legal = at(node, "SpecifiedLegalOrganization", "ID");
  return {
    name: textAt(node, "Name"),
    identifiers: [
      ...childrenOf(node, "SpecifiedTaxRegistration").flatMap(
        (registration) => {
          const id = at(registration, "ID");
          const value = textOf(id);
          const scheme = attributeOf(id, "schemeID");
          return value === null
            ? []
            : [{ kind: taxIdentifierKind(scheme), scheme, value }];
        },
      ),
      ...(textOf(legal) === null
        ? []
        : [
            {
              kind: "registration" as const,
              scheme: attributeOf(legal, "schemeID"),
              value: textOf(legal) ?? "",
            },
          ]),
      ...[...childrenOf(node, "ID"), ...childrenOf(node, "GlobalID")].flatMap(
        (id) => {
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
        },
      ),
    ],
    address: addressLines(
      textAt(address, "LineOne"),
      textAt(address, "LineTwo"),
      textAt(address, "LineThree"),
      joined(" ", textAt(address, "PostcodeCode"), textAt(address, "CityName")),
      textAt(address, "CountrySubDivisionName"),
      textAt(address, "CountryID"),
    ),
  };
};

export const readCiiInvoice = (root: DocumentXmlNode): ParsedEInvoice => {
  const document = at(root, "ExchangedDocument");
  const transaction = at(root, "SupplyChainTradeTransaction");
  const agreement = at(transaction, "ApplicableHeaderTradeAgreement");
  const settlement = at(transaction, "ApplicableHeaderTradeSettlement");
  const summation = at(
    settlement,
    "SpecifiedTradeSettlementHeaderMonetarySummation",
  );
  const terms = childrenOf(settlement, "SpecifiedTradePaymentTerms");
  const taxes = childrenOf(settlement, "ApplicableTradeTax");
  const lines = childrenOf(transaction, "IncludedSupplyChainTradeLineItem");
  const typeCode = textAt(document, "TypeCode");
  const currency = textAt(settlement, "InvoiceCurrencyCode");
  const dueDate =
    terms
      .map((term) => dateOf(at(term, "DueDateDateTime")))
      .find((date) => date !== null) ?? null;
  const invoice: EInvoice = {
    documentType: documentTypeFromUnCode(typeCode),
    typeCode,
    number: textAt(document, "ID"),
    issueDate: dateOf(at(document, "IssueDateTime")),
    taxPointDate:
      taxes
        .map((tax) => dateOf(at(tax, "TaxPointDate")))
        .find((date) => date !== null) ?? null,
    dueDate,
    currency,
    seller: party(at(agreement, "SellerTradeParty")),
    buyer: party(at(agreement, "BuyerTradeParty")),
    lines: capLines(
      lines.map((line) => {
        const quantity = at(
          line,
          "SpecifiedLineTradeDelivery",
          "BilledQuantity",
        );
        const lineSettlement = at(line, "SpecifiedLineTradeSettlement");
        const product = at(line, "SpecifiedTradeProduct");
        return {
          id: textAt(line, "AssociatedDocumentLineDocument", "LineID"),
          description:
            textAt(product, "Name") ?? textAt(product, "Description"),
          quantity: textOf(quantity),
          unitCode: attributeOf(quantity, "unitCode"),
          unitPrice: textAt(
            line,
            "SpecifiedLineTradeAgreement",
            "NetPriceProductTradePrice",
            "ChargeAmount",
          ),
          vatRate: textAt(
            lineSettlement,
            "ApplicableTradeTax",
            "RateApplicablePercent",
          ),
          vatCategory: textAt(
            lineSettlement,
            "ApplicableTradeTax",
            "CategoryCode",
          ),
          netAmount: textAt(
            lineSettlement,
            "SpecifiedTradeSettlementLineMonetarySummation",
            "LineTotalAmount",
          ),
        };
      }),
    ),
    lineCount: lines.length,
    vatBreakdown: taxes.map((tax) => ({
      rate: textAt(tax, "RateApplicablePercent"),
      category: textAt(tax, "CategoryCode"),
      taxableAmount: textAt(tax, "BasisAmount"),
      taxAmount: textAt(tax, "CalculatedAmount"),
      exemptionReason: textAt(tax, "ExemptionReason"),
    })),
    totals: {
      netAmount: textAt(summation, "TaxBasisTotalAmount"),
      taxAmount: amountInCurrency(
        childrenOf(summation, "TaxTotalAmount"),
        currency,
      ),
      grossAmount: textAt(summation, "GrandTotalAmount"),
      prepaidAmount: textAt(summation, "TotalPrepaidAmount"),
      payableAmount: textAt(summation, "DuePayableAmount"),
    },
    payments: childrenOf(
      settlement,
      "SpecifiedTradeSettlementPaymentMeans",
    ).map((means) => {
      const account = at(means, "PayeePartyCreditorFinancialAccount");
      return {
        meansCode: textAt(means, "TypeCode"),
        dueDate,
        amount: null,
        iban: textAt(account, "IBANID"),
        bic: textAt(
          means,
          "PayeeSpecifiedCreditorFinancialInstitution",
          "BICID",
        ),
        accountNumber: textAt(account, "ProprietaryID"),
        bankCode: null,
        reference: textAt(settlement, "PaymentReference"),
      };
    }),
    notes: statedValues([
      ...childrenOf(document, "IncludedNote").map((note) =>
        textAt(note, "Content"),
      ),
      ...terms.map((term) => textAt(term, "Description")),
    ]),
  };
  return {
    version: textAt(
      root,
      "ExchangedDocumentContext",
      "GuidelineSpecifiedDocumentContextParameter",
      "ID",
    ),
    invoices: [invoice],
    embedded: childrenOf(agreement, "AdditionalReferencedDocument").flatMap(
      (reference): EmbeddedInvoiceFile[] => {
        const object = at(reference, "AttachmentBinaryObject");
        const base64 = object?.text ?? "";
        if (base64.trim() === "") {
          return [];
        }
        return [
          {
            fileName:
              attributeOf(object, "filename") ??
              textAt(reference, "IssuerAssignedID") ??
              "attachment",
            description:
              textAt(reference, "Name") ??
              textAt(reference, "IssuerAssignedID"),
            base64,
          },
        ];
      },
    ),
  };
};
