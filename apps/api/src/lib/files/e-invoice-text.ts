import { panic } from "better-result";

import type {
  EInvoice,
  EInvoicePreview,
  XmlDocumentPreview,
} from "@stll/api-contract/e-invoice";
import {
  eInvoiceIdentifierScheme,
  eInvoiceQuantityCount,
  eInvoiceUnit,
  type EInvoiceUnitName,
} from "@stll/api-contract/e-invoice-codes";

/**
 * The invoice as text for search and AI reads: the same fields, in the same
 * order, as the Files preview shows them. Values are the file's own literals.
 */

const SYNTAX_NAMES = {
  isdoc: "ISDOC",
  fatturaPA: "FatturaPA",
  ubl: "UBL",
  cii: "UN/CEFACT CII",
} satisfies Record<EInvoicePreview["syntax"], string>;

const DOCUMENT_TYPE_NAMES = {
  invoice: "Invoice",
  creditNote: "Credit note",
  debitNote: "Debit note",
  advance: "Advance invoice",
  other: "Document",
} satisfies Record<EInvoice["documentType"], string>;

const IDENTIFIER_NAMES = {
  vat: "VAT ID",
  tax: "Tax ID",
  registration: "Registration number",
  other: "Identifier",
} satisfies Record<EInvoice["seller"]["identifiers"][number]["kind"], string>;

const field = (label: string, value: string | null) =>
  value === null ? [] : [`${label}: ${value}`];

const fields = (...parts: [string, string | null][]) =>
  parts.flatMap(([label, value]) =>
    value === null ? [] : [`${label} ${value}`],
  );

const UNIT_NAMES = {
  unit: ["unit", "units"],
  hour: ["hour", "hours"],
  day: ["day", "days"],
  week: ["week", "weeks"],
  month: ["month", "months"],
  year: ["year", "years"],
} as const satisfies Record<EInvoiceUnitName, readonly [string, string]>;

/** A quantity with its unit in words or symbol, the code kept beside it. */
const quantityText = (quantity: string, unitCode: string | null) => {
  if (unitCode === null) {
    return quantity;
  }
  const unit = eInvoiceUnit(unitCode);
  switch (unit.type) {
    case "named": {
      const [one, other] = UNIT_NAMES[unit.name];
      const count = eInvoiceQuantityCount(quantity);
      return count === null
        ? `${quantity} ${unitCode}`
        : `${quantity} ${Math.abs(count) === 1 ? one : other} (${unitCode})`;
    }
    case "symbol":
      return `${quantity} ${unit.symbol} (${unitCode})`;
    case "code":
      return `${quantity} ${unitCode}`;
    default:
      unit satisfies never;
      return panic("Unhandled invoice unit");
  }
};

const identifierLabel = (
  identifier: EInvoice["seller"]["identifiers"][number],
) => {
  const scheme = eInvoiceIdentifierScheme(identifier);
  switch (scheme.type) {
    case "none":
      return IDENTIFIER_NAMES[identifier.kind];
    case "named":
      return identifier.kind === "other"
        ? scheme.name
        : `${IDENTIFIER_NAMES[identifier.kind]} (${scheme.name})`;
    case "code":
      return `${IDENTIFIER_NAMES[identifier.kind]} (${scheme.code})`;
    default:
      scheme satisfies never;
      return panic("Unhandled identifier scheme");
  }
};

const partyText = (role: string, party: EInvoice["seller"]) => [
  `${role}: ${party.name ?? "Name not stated"}`,
  ...party.identifiers.map(
    (identifier) => `  ${identifierLabel(identifier)}: ${identifier.value}`,
  ),
  ...party.address.map((line) => `  ${line}`),
];

const invoiceText = (invoice: EInvoice): string[] => {
  const amount = (value: string | null) =>
    value === null || invoice.currency === null
      ? value
      : `${value} ${invoice.currency}`;
  return [
    [
      DOCUMENT_TYPE_NAMES[invoice.documentType],
      invoice.number,
      invoice.typeCode === null ? null : `(type ${invoice.typeCode})`,
    ]
      .filter((part) => part !== null)
      .join(" "),
    ...field("Issue date", invoice.issueDate),
    ...field("Tax point date", invoice.taxPointDate),
    ...field("Due date", invoice.dueDate),
    ...field("Currency", invoice.currency),
    ...partyText("Seller", invoice.seller),
    ...partyText("Buyer", invoice.buyer),
    ...(invoice.lines.length === 0
      ? []
      : [
          invoice.lineCount > invoice.lines.length
            ? `Lines (${invoice.lines.length} of ${invoice.lineCount}):`
            : `Lines (${invoice.lineCount}):`,
          ...invoice.lines.map((line) =>
            [
              `  ${line.id ?? "-"}. ${line.description ?? "No description"}`,
              ...fields(
                [
                  "quantity",
                  line.quantity === null
                    ? null
                    : quantityText(line.quantity, line.unitCode),
                ],
                [
                  "unit price",
                  line.unitPrice === null || line.priceBasis === null
                    ? line.unitPrice
                    : `${line.unitPrice} per ${quantityText(
                        line.priceBasis.quantity,
                        line.priceBasis.unitCode,
                      )}`,
                ],
                [
                  "VAT",
                  line.vatRate === null && line.vatCategory === null
                    ? null
                    : [line.vatRate, line.vatCategory]
                        .filter((part) => part !== null)
                        .join(" "),
                ],
                ["net", amount(line.netAmount)],
              ),
            ].join("; "),
          ),
        ]),
    ...(invoice.vatBreakdown.length === 0
      ? []
      : [
          "VAT breakdown:",
          ...invoice.vatBreakdown.map((band) =>
            [
              `  ${[band.rate, band.category].filter((part) => part !== null).join(" ") || "-"}`,
              ...fields(
                ["taxable", amount(band.taxableAmount)],
                ["tax", amount(band.taxAmount)],
                ["exemption", band.exemptionReason],
              ),
            ].join("; "),
          ),
        ]),
    ...field(
      "Totals",
      fields(
        ["net", amount(invoice.totals.netAmount)],
        ["VAT", amount(invoice.totals.taxAmount)],
        ["gross", amount(invoice.totals.grossAmount)],
        ["prepaid", amount(invoice.totals.prepaidAmount)],
        ["payable", amount(invoice.totals.payableAmount)],
      ).join("; ") || null,
    ),
    ...invoice.payments.flatMap((payment) => {
      const details = fields(
        ["means", payment.meansCode],
        ["due", payment.dueDate],
        ["amount", amount(payment.amount)],
        ["IBAN", payment.iban],
        ["BIC", payment.bic],
        [
          "account",
          payment.accountNumber === null
            ? null
            : [payment.accountNumber, payment.bankCode]
                .filter((part) => part !== null)
                .join("/"),
        ],
        ["reference", payment.reference],
      );
      return details.length === 0 ? [] : [`Payment: ${details.join("; ")}`];
    }),
    ...(invoice.notes.length === 0
      ? []
      : ["Notes:", ...invoice.notes.map((note) => `  ${note}`)]),
  ];
};

export const eInvoiceDocumentText = (preview: EInvoicePreview): string =>
  [
    `${SYNTAX_NAMES[preview.syntax]} structured invoice${preview.version === null ? "" : `, ${preview.version}`}.`,
    ...preview.invoices.flatMap((invoice) => ["", ...invoiceText(invoice)]),
    ...(preview.attachments.length === 0
      ? []
      : [
          "",
          "Attachments:",
          ...preview.attachments.map(
            ({ fileName, description }) =>
              `  ${fileName}${description === null ? "" : ` (${description})`}`,
          ),
        ]),
  ].join("\n");

/** The text search and AI read for what an invoice reader shows. */
export const xmlDocumentPreviewText = (preview: XmlDocumentPreview): string =>
  preview.type === "invoice"
    ? eInvoiceDocumentText(preview.invoice)
    : `XML document.\n\n${preview.text}${preview.truncated ? "\nDocument text was truncated." : ""}`;
