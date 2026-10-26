import { Result } from "better-result";

import { invalidInput, type InvoicingResult } from "../errors";
import type { InvoiceDocumentType, InvoiceParty } from "../types";
import {
  amountText,
  clip,
  countryCodeOf,
  czechVatBandOf,
  effectiveVatRateBps,
  invoiceDescriptionOf,
  type InvoiceExportLine,
  type InvoiceExportRecord,
  quantityText,
  splitCzechAccountNumber,
  streetOf,
  variableSymbolOf,
} from "./record";
import { el, text, XML_DECLARATION } from "./xml";

// Stormware POHODA XML, data package version 2.0
// (https://www.stormware.cz/schema/version_2/invoice.xsd). Element order
// follows the schema's sequences, which POHODA validates on import.

const NS = {
  dat: "http://www.stormware.cz/schema/version_2/data.xsd",
  inv: "http://www.stormware.cz/schema/version_2/invoice.xsd",
  typ: "http://www.stormware.cz/schema/version_2/type.xsd",
};

const INVOICE_TYPE: Record<InvoiceDocumentType, string> = {
  invoice: "issuedInvoice",
  advance: "issuedAdvanceInvoice",
  credit_note: "issuedCreditNotice",
};

const RATE: Record<ReturnType<typeof czechVatBandOf>, string> = {
  zero: "none",
  reduced: "low",
  // The second reduced rate (10 %, 2015–2023) is POHODA's third rate.
  secondReduced: "third",
  basic: "high",
};

const address = (prefix: "typ", party: InvoiceParty) => [
  text(`${prefix}:company`, clip(party.name, 255)),
  text(`${prefix}:city`, party.city && clip(party.city, 45)),
  text(`${prefix}:street`, clip(streetOf(party), 64)),
  text(`${prefix}:zip`, party.postalCode && clip(party.postalCode, 15)),
  text(
    `${prefix}:ico`,
    party.registrationNumber && clip(party.registrationNumber, 15),
  ),
  text(`${prefix}:dic`, party.vatId && clip(party.vatId, 18)),
];

const classificationOf = (record: InvoiceExportRecord): string | null => {
  const treatments = new Set(record.lines.map((line) => line.vatTreatment));
  if (treatments.size === 1 && treatments.has("domestic_vat")) {
    return "inland";
  }
  if (treatments.size === 1 && treatments.has("not_vat_payer")) {
    return "nonSubsume";
  }
  // Reverse charge, out-of-scope and exempt supplies need a company-specific VAT
  // classification code; POHODA applies the partner's default then.
  return null;
};

const item = (
  line: InvoiceExportLine,
  currency: string,
  home: boolean,
): string =>
  el("inv:invoiceItem", [
    text("inv:text", clip(line.description, 90)),
    text("inv:quantity", quantityText(line.quantity)),
    text("inv:unit", line.unit && clip(line.unit, 10)),
    text("inv:payVAT", "false"),
    text("inv:rateVAT", RATE[czechVatBandOf(effectiveVatRateBps(line))]),
    el(home ? "inv:homeCurrency" : "inv:foreignCurrency", [
      text(
        "typ:unitPrice",
        amountText(line.unitPriceMinor ?? line.netAmountMinor, currency),
      ),
      text("typ:price", amountText(line.netAmountMinor, currency)),
      text("typ:priceVAT", amountText(line.vatAmountMinor, currency)),
      text("typ:priceSum", amountText(line.grossAmountMinor, currency)),
    ]),
    // The item text holds 90 characters; the note carries the next 90.
    text("inv:note", clip(Array.from(line.description).slice(90).join(""), 90)),
  ]);

const invoice = (record: InvoiceExportRecord): string => {
  const home = record.currency === record.seller.homeCurrency;
  const account = splitCzechAccountNumber(record.seller.accountNumber);
  const classification = classificationOf(record);
  const description = invoiceDescriptionOf(record);
  return el(
    "inv:invoice",
    [
      el("inv:invoiceHeader", [
        text("inv:invoiceType", INVOICE_TYPE[record.documentType]),
        el("inv:number", text("typ:numberRequested", clip(record.number, 32))),
        text("inv:symVar", variableSymbolOf(record)),
        text(
          "inv:originalDocument",
          record.originalNumber && clip(record.originalNumber, 32),
        ),
        text("inv:date", record.issueDate),
        text(
          "inv:dateTax",
          record.documentType === "advance" ? null : record.taxableSupplyDate,
        ),
        text(
          "inv:dateAccounting",
          record.taxableSupplyDate ?? record.issueDate,
        ),
        text("inv:dateDue", record.dueDate),
        classification
          ? el(
              "inv:classificationVAT",
              text("typ:classificationVATType", classification),
            )
          : "",
        text(
          "inv:text",
          clip(description ?? `${record.matter.name} ${record.number}`, 240),
        ),
        el(
          "inv:partnerIdentity",
          el("typ:address", [
            ...address("typ", record.buyer),
            countryCodeOf(record.buyer.country)
              ? el(
                  "typ:country",
                  text("typ:ids", countryCodeOf(record.buyer.country)),
                )
              : "",
          ]),
        ),
        el("inv:myIdentity", el("typ:address", address("typ", record.seller))),
        account
          ? el("inv:account", [
              text("typ:accountNo", account.account),
              text("typ:bankCode", account.bankCode),
            ])
          : "",
      ]),
      el(
        "inv:invoiceDetail",
        record.lines.map((line) => item(line, record.currency, home)),
      ),
      el("inv:invoiceSummary", [
        text("inv:roundingDocument", "none"),
        text("inv:roundingVAT", "none"),
        home
          ? ""
          : el("inv:foreignCurrency", [
              el("typ:currency", text("typ:ids", record.currency)),
              text("typ:amount", "1"),
              text(
                "typ:priceSum",
                amountText(record.totals.grossAmountMinor, record.currency),
              ),
            ]),
      ]),
    ],
    { version: "2.0" },
  );
};

/**
 * Issued invoices as one POHODA data package. POHODA imports a package into
 * the company whose registration number (IČO) it names, so every invoice must
 * come from the same seller and that seller needs an IČO.
 */
export const buildPohodaXml = (
  records: readonly InvoiceExportRecord[],
  packageId: string,
): InvoicingResult<string> => {
  const first = records[0];
  if (!first) {
    return invalidInput("There are no issued invoices to export");
  }
  const sellerIds = new Set(
    records.map((record) => record.seller.registrationNumber ?? ""),
  );
  const ico = first.seller.registrationNumber?.trim();
  if (!ico || sellerIds.size > 1) {
    return invalidInput(
      "A POHODA package needs every invoice from one seller with a company registration number (IČO)",
    );
  }
  const items = records.map((record) =>
    el("dat:dataPackItem", invoice(record), {
      id: clip(record.number, 64),
      version: "2.0",
    }),
  );
  const root = el("dat:dataPack", items, {
    "xmlns:dat": NS.dat,
    "xmlns:inv": NS.inv,
    "xmlns:typ": NS.typ,
    id: clip(packageId, 64),
    ico: clip(ico, 15),
    application: "Stella",
    version: "2.0",
    note: "Issued invoices",
  });
  return Result.ok(`${XML_DECLARATION}${root}\n`);
};
