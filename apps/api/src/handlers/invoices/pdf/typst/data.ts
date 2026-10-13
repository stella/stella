import { Result } from "better-result";
import { encode } from "uqr";

import type { InvoiceDocumentType, VatTreatment } from "@stll/invoicing";

import {
  buildInvoicePaymentPayload,
  createInvoiceFormatters,
  INVOICE_PDF_LABELS,
} from "../render";
import type { RenderInvoicePdfOptions } from "../render";

type Labels = (typeof INVOICE_PDF_LABELS)[keyof typeof INVOICE_PDF_LABELS];

type Field = { label: string; value: string };

type Party = {
  heading: string;
  name: string | null;
  address: string[];
  ids: Field[];
};

/**
 * Everything the invoice template prints, already localised. Templates only
 * lay it out: amounts, dates and rates are formatted by the same functions as
 * the hand-placed renderer, and raw minor units are kept for templates that
 * need arithmetic-free conditions (for example "show the QR only if due > 0").
 */
type InvoiceTemplateData = {
  lang: string;
  dir: "ltr" | "rtl";
  title: string;
  isDraft: boolean;
  draftLabel: string;
  meta: Field[];
  seller: Party | null;
  buyer: Party;
  labels: {
    description: string;
    quantity: string;
    unitPrice: string;
    net: string;
    vat: string;
    total: string;
    payment: string;
    notes: string;
  };
  lines: {
    description: string;
    quantity: string | null;
    unitPrice: string | null;
    net: string;
    vatLabel: string;
    vat: string;
    total: string;
  }[];
  totals: {
    net: string;
    vat: string;
    gross: string;
    grossMinor: number;
    breakdown: { label: string; net: string; vat: string }[];
  };
  payment: {
    fields: Field[];
    accountNumber: string | null;
    /** SVG markup of the SPAYD QR code, or null when nothing is payable. */
    qrSvg: string | null;
  } | null;
  notes: string | null;
  footerNotes: string | null;
};

const compact = (values: (string | null | undefined)[]) =>
  values.filter(
    (value): value is string =>
      value !== null && value !== undefined && value !== "",
  );

const fields = (entries: [string, string | null | undefined][]): Field[] =>
  entries.flatMap(([label, value]) =>
    value === null || value === undefined || value === ""
      ? []
      : [{ label, value }],
  );

/** One path per dark module run, so the SVG stays small and crisp. */
export const qrSvg = (payload: string) => {
  const qr = encode(payload, { border: 4, ecc: "M" });
  const runs: string[] = [];
  for (const [y, row] of qr.data.entries()) {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < row.length && row[x]) {
        x += 1;
      }
      runs.push(`M${start} ${y}h${x - start}v1h${start - x}z`);
    }
  }
  const size = qr.size;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path fill="#000" d="${runs.join("")}"/></svg>`;
};

const party = (
  heading: string,
  l: Labels,
  value: {
    name: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    postalCode: string | null;
    city: string | null;
    country: string | null;
    registrationId: string | null;
    vatId: string | null;
  },
): Party => ({
  heading,
  name: value.name,
  address: compact([
    value.addressLine1,
    value.addressLine2,
    compact([value.postalCode, value.city]).join(" "),
    value.country,
  ]),
  ids: fields([
    [l.registration, value.registrationId],
    [l.vatId, value.vatId],
  ]),
});

export const buildInvoiceTemplateData = (options: RenderInvoicePdfOptions) => {
  const { invoice, seller, totals, locale, lang, originalNumber } = options;
  const l = INVOICE_PDF_LABELS[lang];
  const { money, date, vatRate, quantity } = createInvoiceFormatters({
    currency: invoice.currency,
    locale,
  });
  const titles = {
    invoice: l.invoice,
    advance: l.advance,
    credit_note: l.credit,
  } satisfies Record<InvoiceDocumentType, string>;
  const treatments = {
    domestic_vat: l.vat,
    reverse_charge: l.reverse,
    exempt: l.exempt,
    not_vat_payer: l.nonPayer,
  } satisfies Record<VatTreatment, string>;

  let qr: string | null = null;
  const payment = buildInvoicePaymentPayload(options);
  if (payment !== null) {
    if (payment.isErr()) {
      return Result.err(payment.error);
    }
    if (payment.value.status === "payable") {
      qr = qrSvg(payment.value.payload);
    }
  }

  const data: InvoiceTemplateData = {
    lang,
    dir: lang === "ar" ? "rtl" : "ltr",
    title:
      invoice.status !== "draft" && invoice.invoiceNumber !== null
        ? `${titles[invoice.documentType]} ${invoice.invoiceNumber}`
        : titles[invoice.documentType],
    isDraft: invoice.status === "draft",
    draftLabel: l.draft,
    meta: fields([
      [l.original, originalNumber],
      [l.issueDate, date(invoice.invoiceDate)],
      [l.dueDate, invoice.dueDate === null ? null : date(invoice.dueDate)],
      [
        l.taxDate,
        invoice.taxableSupplyDate === null
          ? null
          : date(invoice.taxableSupplyDate),
      ],
      [l.reference, invoice.reference],
    ]),
    seller:
      seller === null
        ? null
        : party(l.seller, l, { ...seller, name: seller.legalName }),
    buyer: party(l.buyer, l, {
      name: invoice.buyerName,
      addressLine1: invoice.buyerAddressLine1,
      addressLine2: invoice.buyerAddressLine2,
      postalCode: invoice.buyerPostalCode,
      city: invoice.buyerCity,
      country: invoice.buyerCountry,
      registrationId: invoice.buyerRegistrationId,
      vatId: invoice.buyerVatId,
    }),
    labels: {
      description: l.description,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      net: l.net,
      vat: l.vat,
      total: l.total,
      payment: l.payment,
      notes: l.notes,
    },
    lines: invoice.lines.map((line) => {
      const billed = line.quantity !== null && line.unitPrice !== null;
      return {
        description: line.description,
        quantity:
          billed && line.quantity !== null
            ? compact([quantity(line.quantity), line.unit]).join(" ")
            : null,
        unitPrice:
          billed && line.unitPrice !== null ? money(line.unitPrice) : null,
        net: money(line.netAmount),
        vatLabel: `${treatments[line.vatTreatment]} ${vatRate(line.vatRateBps)}`,
        vat: money(line.vatAmount),
        total: money(line.grossAmount),
      };
    }),
    totals: {
      net: money(totals.netAmountMinor),
      vat: money(totals.vatAmountMinor),
      gross: money(totals.grossAmountMinor),
      grossMinor: totals.grossAmountMinor,
      breakdown: totals.vatBreakdown.map((row) => ({
        label: `${treatments[row.vatTreatment]} ${vatRate(row.vatRateBps)}`,
        net: money(row.netAmountMinor),
        vat: money(row.vatAmountMinor),
      })),
    },
    payment:
      seller === null
        ? null
        : {
            fields: fields([
              ["IBAN", seller.iban],
              ["BIC", seller.bic],
            ]),
            accountNumber: seller.accountNumber,
            qrSvg: qr,
          },
    notes: invoice.notes,
    footerNotes: seller?.footerNotes ?? null,
  };
  return Result.ok(data);
};
