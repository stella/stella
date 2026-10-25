import { panic, Result } from "better-result";
import { encode } from "uqr";

import { isCountryCode } from "@stll/country-codes";
import {
  formatExchangeRate,
  homeCurrencyVat,
  INVOICE_COUNTRY_PROFILES,
  INVOICE_PDF_LABELS,
  invoiceCountryOf,
  type InvoiceDocumentType,
  type InvoicePartyId,
  invoiceSellerCountryOf,
  isVatRateSource,
  legalNotesFor,
  VAT_RATE_QUOTE_BASIS,
  type VatTreatment,
} from "@stll/invoicing";
import { formatMoneyCents } from "@stll/money";

import { groupInvoiceLinesByMatter } from "../matter-groups";
import {
  buildInvoicePaymentPayload,
  createInvoiceFormatters,
} from "../render-helpers";
import type { RenderInvoicePdfOptions } from "../render-helpers";
import payBySquareLogo from "./pay-by-square.svg" with { type: "text" };

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
    vatHome: string;
    vatHomeTotal: string;
    exchangeRate: string;
    rateSource: string;
    rateDate: string;
  };
  groups: {
    workspaceId: string;
    workspaceName: string;
    net: string;
    vat: string;
    total: string;
    lines: {
      description: string;
      quantity: string | null;
      unitPrice: string | null;
      net: string;
      vatLabel: string;
      vat: string;
      total: string;
    }[];
  }[];
  totals: {
    net: string;
    vat: string;
    gross: string;
    grossMinor: number;
    breakdown: { label: string; net: string; vat: string }[];
    homeVat: {
      total: string;
      breakdown: { label: string; vat: string }[];
      rate: string;
      source: string;
      date: string;
    } | null;
  };
  payment: {
    fields: Field[];
    accountNumber: string | null;
    /** SVG markup of the supported domestic payment QR code, or null when nothing is payable. */
    qrSvg: string | null;
    qrWidthMm: number;
  } | null;
  legalNotes: string[];
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
export const qrSvg = (payload: string, ecc: "L" | "M" = "M") => {
  const qr = encode(payload, { border: 4, ecc });
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

/** The country's name in the invoice language; an unknown code prints as stored. */
const countryName = (code: string | null, lang: string) => {
  // The column is free text; only an assigned ISO 3166 code has a display name.
  if (code === null || !isCountryCode(code)) {
    return code;
  }
  return new Intl.DisplayNames([lang], { type: "region" }).of(code) ?? code;
};

type PartyOptions = {
  heading: string;
  lang: string;
  labels: Labels;
  value: {
    name: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    postalCode: string | null;
    city: string | null;
    country: string | null;
    registrationId: string | null;
    taxId: string | null;
    vatId: string | null;
  };
  printedIds: readonly InvoicePartyId[];
  domesticTaxIdLabel: string | null;
};

const party = ({
  heading,
  lang,
  labels: l,
  value,
  printedIds,
  domesticTaxIdLabel,
}: PartyOptions): Party => ({
  heading,
  name: value.name,
  address: compact([
    value.addressLine1,
    value.addressLine2,
    compact([value.postalCode, value.city]).join(" "),
    countryName(value.country, lang),
  ]),
  ids: fields([
    [
      l.registration,
      printedIds.includes("registration") ? value.registrationId : null,
    ],
    [
      domesticTaxIdLabel !== null && invoiceSellerCountryOf(value) === "PL"
        ? domesticTaxIdLabel
        : l.taxId,
      printedIds.includes("taxId") ? value.taxId : null,
    ],
    [
      domesticTaxIdLabel !== null && invoiceSellerCountryOf(value) === "PL"
        ? domesticTaxIdLabel
        : l.vatId,
      printedIds.includes("vatId") ? value.vatId : null,
    ],
  ]),
});

type HomeCurrencyVatBlockOptions = {
  options: RenderInvoicePdfOptions;
  country: ReturnType<typeof invoiceCountryOf>;
  lang: RenderInvoicePdfOptions["invoice"]["language"];
  labelFor: (row: { vatTreatment: VatTreatment; vatRateBps: number }) => string;
  date: (value: string) => string;
};

/** The home-currency VAT block of an invoice that stores an official rate. */
const homeCurrencyVatBlock = ({
  options: { invoice, totals },
  country,
  lang,
  labelFor,
  date,
}: HomeCurrencyVatBlockOptions) => {
  const profile = INVOICE_COUNTRY_PROFILES[country];
  if (
    invoice.vatExchangeRate === null ||
    invoice.vatExchangeRate === undefined ||
    invoice.vatExchangeRateSource === null ||
    invoice.vatExchangeRateSource === undefined ||
    invoice.vatExchangeRateDate === null ||
    invoice.vatExchangeRateDate === undefined ||
    profile.vatCurrency === null ||
    (country !== "CZ" && country !== "SK" && country !== "PL")
  ) {
    return null;
  }
  const source = invoice.vatExchangeRateSource;
  if (!isVatRateSource(source)) {
    return panic(`Unknown VAT exchange-rate source: ${source}`);
  }
  const converted = homeCurrencyVat({
    country,
    rate: invoice.vatExchangeRate,
    source,
    vatBreakdown: totals.vatBreakdown,
  });
  const homeMoney = (amountCents: number) =>
    formatMoneyCents({
      amountCents,
      currency: profile.vatCurrency,
      locale: lang,
    });
  const displayRate = formatExchangeRate(invoice.vatExchangeRate, lang);
  return {
    total: homeMoney(converted.totalVatAmountMinor),
    breakdown: converted.byRate.map((row) => ({
      label: labelFor(row),
      vat: homeMoney(row.vatAmountMinor),
    })),
    // The rate reads the way its source publishes it.
    rate:
      VAT_RATE_QUOTE_BASIS[source] === "home_per_foreign"
        ? `1 ${invoice.currency} = ${displayRate} ${profile.vatCurrency}`
        : `1 ${profile.vatCurrency} = ${displayRate} ${invoice.currency}`,
    source: invoice.vatExchangeRateSource,
    date: date(invoice.vatExchangeRateDate),
  };
};

export const buildInvoiceTemplateData = (options: RenderInvoicePdfOptions) => {
  const { invoice, seller, totals, originalNumber } = options;
  const lang = invoice.language;
  const l = INVOICE_PDF_LABELS[lang];
  const country = invoiceCountryOf(seller ?? { country: null, vatId: null });
  const profile = INVOICE_COUNTRY_PROFILES[country];
  const { money, date, vatRate, quantity } = createInvoiceFormatters({
    currency: invoice.currency,
    locale: invoice.language,
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
    outside_scope: l.outsideScope,
    not_vat_payer: l.nonPayer,
  } satisfies Record<VatTreatment, string>;
  const homeVat = homeCurrencyVatBlock({
    options,
    country,
    lang,
    labelFor: (row) =>
      `${treatments[row.vatTreatment]} ${vatRate(row.vatRateBps)}`,
    date,
  });

  let qr: string | null = null;
  let qrWidthMm = 32;
  const payment = buildInvoicePaymentPayload(options);
  if (payment !== null) {
    if (payment.isErr()) {
      return Result.err(payment.error);
    }
    if (payment.value.status === "payable") {
      qr = qrSvg(payment.value.payload, payment.value.errorCorrection);
      if (payment.value.scheme === "pay_by_square") {
        // Official print frame: the 62-unit QR box stays inside its 64-unit
        // width with four quiet modules; 37.254 mm is the recommended size.
        const framed = `${qr.replace("<svg ", '<svg x="1" y="1" width="62" height="62" ')}</svg>`;
        qr = payBySquareLogo.replace("</svg>", () => framed);
        qrWidthMm = 37.254;
      }
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
        profile.supplyDateLabel[lang],
        invoice.taxableSupplyDate === null
          ? null
          : date(invoice.taxableSupplyDate),
      ],
      [l.reference, invoice.reference],
    ]),
    seller:
      seller === null
        ? null
        : party({
            heading: l.seller,
            lang,
            labels: l,
            value: { ...seller, name: seller.legalName },
            printedIds: profile.partyIds.seller,
            domesticTaxIdLabel: profile.domesticTaxIdLabel,
          }),
    buyer: party({
      heading: l.buyer,
      lang,
      labels: l,
      value: {
        name: invoice.buyerName,
        addressLine1: invoice.buyerAddressLine1,
        addressLine2: invoice.buyerAddressLine2,
        postalCode: invoice.buyerPostalCode,
        city: invoice.buyerCity,
        country: invoice.buyerCountry,
        registrationId: invoice.buyerRegistrationId,
        taxId: invoice.buyerTaxId,
        vatId: invoice.buyerVatId,
      },
      printedIds: profile.partyIds.buyer,
      domesticTaxIdLabel: profile.domesticTaxIdLabel,
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
      vatHome: l.vatHome,
      vatHomeTotal: l.vatHomeTotal,
      exchangeRate: l.exchangeRate,
      rateSource: l.rateSource,
      rateDate: l.rateDate,
    },
    groups: groupInvoiceLinesByMatter(invoice.lines).map((group) => ({
      workspaceId: group.workspaceId,
      workspaceName: group.workspaceName,
      net: money(group.netAmount),
      vat: money(group.vatAmount),
      total: money(group.grossAmount),
      lines: group.lines.map((line) => {
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
          // Only the rate: the treatment is named in the VAT breakdown and the
          // legal notes, and a long treatment label would squeeze the description.
          vatLabel: vatRate(line.vatRateBps),
          vat: money(line.vatAmount),
          total: money(line.grossAmount),
        };
      }),
    })),
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
      homeVat,
    },
    payment:
      seller === null
        ? null
        : {
            // What a payer needs beside the QR code: amount, due date, reference.
            fields: fields([
              [l.total, money(totals.grossAmountMinor)],
              [
                l.dueDate,
                invoice.dueDate === null ? null : date(invoice.dueDate),
              ],
              [l.reference, invoice.reference],
              ["IBAN", seller.iban],
              ["BIC", seller.bic],
            ]),
            accountNumber: seller.accountNumber,
            qrSvg: qr,
            qrWidthMm,
          },
    legalNotes: legalNotesFor({
      profile,
      language: lang,
      treatments: invoice.lines.map((line) => line.vatTreatment),
      exemptionReasons: invoice.lines.flatMap((line) =>
        line.exemptionReason ? [line.exemptionReason] : [],
      ),
    }),
    notes: invoice.notes,
    footerNotes:
      compact([
        seller?.registerEntry,
        seller?.barRegistration,
        seller?.footerNotes,
      ]).join("\n") || null,
  };
  return Result.ok(data);
};
