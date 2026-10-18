import {
  PDF,
  type PDFFormXObject,
  PdfArray,
  PdfDict,
  PdfName,
  PdfNumber,
  PdfStream,
  ops,
  rgb,
} from "@libpdf/core";
import { panic, Result } from "better-result";
import { encode } from "uqr";

import type { InvoiceLanguage, InvoiceStatus } from "@stll/api-contract";
import {
  buildCzechQrPaymentPayload,
  buildPayBySquarePayload,
  INVOICE_COUNTRY_PROFILES,
  INVOICE_PDF_LABELS,
  invoiceCountryOf,
  legalNotesFor,
  paymentQrSchemeFor,
  variableSymbolOf,
} from "@stll/invoicing";
import type {
  InvoiceDocumentType,
  InvoicePartyId,
  InvoiceTotals,
  VatTreatment,
} from "@stll/invoicing";
import { formatMoneyCents, toMajorUnits } from "@stll/money";
import { parsePlainDate } from "@stll/time";

import { savePdfRewrite } from "@/api/lib/files/pdf-signatures";
import dejaVuPath from "@/api/lib/files/pdf-signing/fonts/DejaVuSans.ttf" with { type: "file" };
import { loadStampFonts } from "@/api/lib/files/pdf-signing/stamp-font";
import { drawStampRows } from "@/api/lib/files/pdf-signing/stamp-glyphs";
import {
  FIRST_STRONG_ISOLATE,
  layoutStampRow,
  POP_DIRECTIONAL_ISOLATE,
  STAMP_UNITS_PER_EM,
} from "@/api/lib/files/pdf-signing/stamp-layout";

export type RenderInvoicePdfOptions = {
  invoice: {
    status: InvoiceStatus;
    documentType: InvoiceDocumentType;
    invoiceNumber: string | null;
    invoiceDate: string;
    dueDate: string | null;
    taxableSupplyDate: string | null;
    currency: string;
    language: InvoiceLanguage;
    reference: string | null;
    notes: string | null;
    buyerName: string | null;
    buyerRegistrationId: string | null;
    buyerTaxId: string | null;
    buyerVatId: string | null;
    buyerAddressLine1: string | null;
    buyerAddressLine2: string | null;
    buyerCity: string | null;
    buyerPostalCode: string | null;
    buyerCountry: string | null;
    lines: {
      description: string;
      /** Null only on a line that was never billed by quantity. */
      quantity: string | null;
      unit: string | null;
      unitPrice: number | null;
      netAmount: number;
      vatAmount: number;
      grossAmount: number;
      vatRateBps: number;
      vatTreatment: VatTreatment;
      exemptionReason?: string | null;
    }[];
  };
  seller: {
    legalName: string;
    registrationId: string | null;
    taxId: string | null;
    vatId: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    postalCode: string | null;
    country: string | null;
    iban: string | null;
    bic: string | null;
    accountNumber: string | null;
    registerEntry: string | null;
    barRegistration: string | null;
    footerNotes: string | null;
  } | null;
  totals: InvoiceTotals;
  originalNumber: string | null;
};

export const buildInvoicePaymentPayload = ({
  invoice,
  seller,
  totals,
}: RenderInvoicePdfOptions) => {
  if (
    invoice.documentType === "credit_note" ||
    totals.grossAmountMinor <= 0 ||
    !seller?.iban
  ) {
    return null;
  }
  const scheme = paymentQrSchemeFor({
    iban: seller.iban,
    currency: invoice.currency,
  });
  const variableSymbol = variableSymbolOf({
    number: invoice.invoiceNumber ?? "",
    reference: invoice.reference,
  });
  switch (scheme) {
    case "spayd":
      return buildCzechQrPaymentPayload({
        documentType: invoice.documentType,
        iban: seller.iban,
        amountMinor: totals.grossAmountMinor,
        currency: invoice.currency,
        ...(invoice.dueDate === null ? {} : { dueDate: invoice.dueDate }),
        ...(variableSymbol === null ? {} : { variableSymbol }),
        ...(invoice.status === "draft" || invoice.invoiceNumber === null
          ? {}
          : { message: invoice.invoiceNumber }),
      });
    case "pay_by_square": {
      if (invoice.dueDate === null) {
        return null;
      }
      return buildPayBySquarePayload({
        amount: toMajorUnits({
          amountCents: totals.grossAmountMinor,
          currency: invoice.currency,
        }),
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        ...(variableSymbol === null ? {} : { variableSymbol }),
        paymentNote:
          invoice.status === "draft" || invoice.invoiceNumber === null
            ? ""
            : invoice.invoiceNumber,
        iban: seller.iban,
        ...(seller.bic === null ? {} : { bic: seller.bic }),
        beneficiaryName: seller.legalName,
      });
    }
    case null:
      return null;
    default: {
      scheme satisfies never;
      return panic("Unknown payment QR scheme");
    }
  }
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 42;
const FONT_SIZE = 10;
const LINE_HEIGHT = 15;
const QR_SIZE = 120;

type ShapedRow = Parameters<typeof drawStampRows>[0]["rows"][number];
type InvoiceWriterOptions = { pdf: PDF; lang: InvoiceLanguage };
const createInvoiceWriter = async ({ pdf, lang }: InvoiceWriterOptions) => {
  const font = pdf.embedFont(
    new Uint8Array(await Bun.file(dejaVuPath).arrayBuffer()),
  );
  // Reuse the PDF text owner for Arabic shaping, bidi ordering and extraction.
  const shapedFonts = lang === "ar" ? await loadStampFonts() : null;
  let page = pdf.addPage({ width: PAGE_WIDTH, height: PAGE_HEIGHT });
  let y = PAGE_HEIGHT - MARGIN;
  const initialRows: ShapedRow[] = [];
  const shapedPages = [{ page, rows: initialRows }];
  const isolate = (value: string) =>
    lang === "ar"
      ? `${FIRST_STRONG_ISOLATE}${value}${POP_DIRECTIONAL_ISOLATE}`
      : value;
  const measure = (text: string) =>
    shapedFonts === null
      ? font.getTextWidth(text, FONT_SIZE)
      : (layoutStampRow({ direction: "rtl", fonts: shapedFonts, text }).width *
          FONT_SIZE) /
        STAMP_UNITS_PER_EM;
  const draw = (text: string) => {
    if (shapedFonts === null) {
      page.drawText(text, { x: MARGIN, y, font, size: FONT_SIZE });
      return;
    }
    const row = layoutStampRow({ direction: "rtl", fonts: shapedFonts, text });
    const rows = shapedPages.at(-1)?.rows ?? panic("Invoice page disappeared");
    rows.push({
      row,
      x: PAGE_WIDTH - MARGIN - (row.width * FONT_SIZE) / STAMP_UNITS_PER_EM,
      y,
    });
  };
  const newPage = () => {
    page = pdf.addPage({ width: PAGE_WIDTH, height: PAGE_HEIGHT });
    shapedPages.push({ page, rows: [] });
    y = PAGE_HEIGHT - MARGIN;
  };
  const writeLine = (text: string) => {
    if (y < MARGIN + LINE_HEIGHT) {
      newPage();
    }
    draw(text);
    y -= LINE_HEIGHT;
  };
  const write = (text: string) => {
    for (const paragraph of text.split(/\r\n|\r|\n/u)) {
      let line = "";
      for (const word of paragraph.split(/\s+/u)) {
        const candidate = line === "" ? word : `${line} ${word}`;
        if (measure(candidate) <= PAGE_WIDTH - MARGIN * 2) {
          line = candidate;
          continue;
        }
        if (line !== "") {
          writeLine(line);
          line = "";
        }
        for (const character of word) {
          if (
            measure(line + character) > PAGE_WIDTH - MARGIN * 2 &&
            line !== ""
          ) {
            writeLine(line);
            line = "";
          }
          line += character;
        }
      }
      writeLine(line);
    }
  };
  const field = (label: string, value: string | null) => {
    if (value !== null && value !== "") {
      write(`${label}: ${isolate(value)}`);
    }
  };
  const writeQr = (payload: string) => {
    if (y < MARGIN + QR_SIZE + LINE_HEIGHT) {
      newPage();
    }
    const qr = encode(payload, { border: 4, ecc: "M" });
    const moduleSize = QR_SIZE / qr.size;
    page.drawRectangle({
      x: MARGIN,
      y: y - QR_SIZE,
      width: QR_SIZE,
      height: QR_SIZE,
      color: rgb(1, 1, 1),
    });
    for (const [rowIndex, row] of qr.data.entries()) {
      for (const [columnIndex, black] of row.entries()) {
        if (black) {
          page.drawRectangle({
            x: MARGIN + columnIndex * moduleSize,
            y: y - (rowIndex + 1) * moduleSize,
            width: moduleSize,
            height: moduleSize,
            color: rgb(0, 0, 0),
          });
        }
      }
    }
    y -= QR_SIZE + LINE_HEIGHT;
  };
  const finish = () => {
    if (shapedFonts !== null) {
      for (const { page: shapedPage, rows } of shapedPages) {
        const shaped = drawStampRows({ fontSize: FONT_SIZE, pdf, rows });
        const stream = new PdfStream(
          PdfDict.of({
            Type: PdfName.of("XObject"),
            Subtype: PdfName.of("Form"),
            BBox: new PdfArray(
              [0, 0, PAGE_WIDTH, PAGE_HEIGHT].map((value) =>
                PdfNumber.of(value),
              ),
            ),
            Resources: PdfDict.of({ Font: shaped.fonts }),
          }),
          new TextEncoder().encode(
            ["BT", ...shaped.operators, "ET"].join("\n"),
          ),
        );
        const ref = pdf.context.registry.register(stream);
        const object = {
          type: "formxobject",
          ref,
          bbox: { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT },
        } as const satisfies PDFFormXObject;
        const name = shapedPage.registerXObject(object);
        shapedPage.drawOperators([ops.paintXObject(name)]);
      }
    }
  };
  return { write, field, isolate, writeQr, finish };
};

/**
 * Locale formatting shared by every invoice renderer, so the hand-placed
 * layout and the Typst template print identical amounts, dates and rates.
 */
export const createInvoiceFormatters = ({
  currency,
  locale,
}: {
  currency: string;
  locale: string;
}) => {
  const money = (amountCents: number) =>
    formatMoneyCents({ amountCents, currency, locale });
  const date = (value: string) => {
    const parsed =
      parsePlainDate(value) ??
      panic("Invoice contains an invalid calendar date");
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeZone: "UTC",
    }).format(parsed.toZonedDateTime("UTC").epochMilliseconds);
  };
  const vatRate = (value: number) =>
    new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: 2,
    }).format(value / 10_000);
  const quantityFormat = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 4,
  });
  // Stored quantities are decimal strings with up to four decimals. One that
  // a double cannot hold exactly is printed as stored, never rounded.
  const quantity = (value: string) => {
    const [whole = "", decimals = ""] = value.split(".");
    let kept = decimals.length;
    while (kept > 0 && decimals[kept - 1] === "0") {
      kept -= 1;
    }
    const canonical =
      kept === 0 ? whole : `${whole}.${decimals.slice(0, kept)}`;
    const parsed = Number(canonical);
    return String(parsed) === canonical
      ? quantityFormat.format(parsed)
      : canonical;
  };
  return { money, date, vatRate, quantity };
};

const writeProfileId = ({
  field,
  ids,
  id,
  label,
  value,
}: {
  field: (label: string, value: string | null) => void;
  ids: readonly InvoicePartyId[];
  id: InvoicePartyId;
  label: string;
  value: string | null;
}) => {
  if (ids.includes(id)) {
    field(label, value);
  }
};

const invoiceLegalNotes = ({ invoice, seller }: RenderInvoicePdfOptions) => {
  const profile =
    INVOICE_COUNTRY_PROFILES[
      invoiceCountryOf(seller ?? { country: null, vatId: null })
    ];
  return legalNotesFor({
    profile,
    language: invoice.language,
    treatments: invoice.lines.map((line) => line.vatTreatment),
    exemptionReasons: invoice.lines.flatMap((line) =>
      line.exemptionReason ? [line.exemptionReason] : [],
    ),
  });
};

export const renderInvoicePdf = async (options: RenderInvoicePdfOptions) => {
  const { invoice, seller, totals, originalNumber } = options;
  const lang = invoice.language;
  const l = INVOICE_PDF_LABELS[lang];
  const profile =
    INVOICE_COUNTRY_PROFILES[
      invoiceCountryOf(seller ?? { country: null, vatId: null })
    ];
  const pdf = PDF.create();
  const { write, field, isolate, writeQr, finish } = await createInvoiceWriter({
    pdf,
    lang,
  });
  const titles = {
    invoice: l.invoice,
    advance: l.advance,
    credit_note: l.credit,
  } satisfies Record<InvoiceDocumentType, string>;
  const title = `${titles[invoice.documentType]}${invoice.status === "draft" || invoice.invoiceNumber === null ? "" : ` ${invoice.invoiceNumber}`}`;
  const { money, date, vatRate, quantity } = createInvoiceFormatters({
    currency: invoice.currency,
    locale: invoice.language,
  });
  const treatments = {
    domestic_vat: l.vat,
    reverse_charge: l.reverse,
    outside_scope: l.outsideScope,
    exempt: l.exempt,
    not_vat_payer: l.nonPayer,
  } satisfies Record<VatTreatment, string>;

  write(title);
  if (invoice.status === "draft") {
    write(l.draft);
  }
  field(l.original, originalNumber);
  field(l.issueDate, date(invoice.invoiceDate));
  if (invoice.dueDate !== null) {
    field(l.dueDate, date(invoice.dueDate));
  }
  if (invoice.taxableSupplyDate !== null) {
    field(profile.supplyDateLabel[lang], date(invoice.taxableSupplyDate));
  }
  field(l.reference, invoice.reference);
  write("");
  write(l.seller);
  if (seller !== null) {
    write(seller.legalName);
    for (const value of [
      seller.addressLine1,
      seller.addressLine2,
      [seller.postalCode, seller.city]
        .filter((part) => part !== null)
        .join(" "),
      seller.country,
    ]) {
      if (value) {
        write(value);
      }
    }
    writeProfileId({
      field,
      ids: profile.partyIds.seller,
      id: "registration",
      label: l.registration,
      value: seller.registrationId,
    });
    writeProfileId({
      field,
      ids: profile.partyIds.seller,
      id: "taxId",
      label: l.taxId,
      value: seller.taxId,
    });
    writeProfileId({
      field,
      ids: profile.partyIds.seller,
      id: "vatId",
      label: l.vatId,
      value: seller.vatId,
    });
  }
  write("");
  write(l.buyer);
  for (const value of [
    invoice.buyerName,
    invoice.buyerAddressLine1,
    invoice.buyerAddressLine2,
    [invoice.buyerPostalCode, invoice.buyerCity]
      .filter((part) => part !== null)
      .join(" "),
    invoice.buyerCountry,
  ]) {
    if (value) {
      write(value);
    }
  }
  writeProfileId({
    field,
    ids: profile.partyIds.buyer,
    id: "registration",
    label: l.registration,
    value: invoice.buyerRegistrationId,
  });
  writeProfileId({
    field,
    ids: profile.partyIds.buyer,
    id: "taxId",
    label: l.taxId,
    value: invoice.buyerTaxId,
  });
  writeProfileId({
    field,
    ids: profile.partyIds.buyer,
    id: "vatId",
    label: l.vatId,
    value: invoice.buyerVatId,
  });
  write("");
  for (const line of invoice.lines) {
    field(l.description, line.description);
    if (line.quantity !== null && line.unitPrice !== null) {
      const billed =
        line.unit === null
          ? quantity(line.quantity)
          : `${quantity(line.quantity)} ${line.unit}`;
      write(
        `${l.quantity}: ${isolate(billed)}   ${l.unitPrice}: ${isolate(money(line.unitPrice))}`,
      );
    }
    write(
      `${l.net}: ${isolate(money(line.netAmount))}   ${treatments[line.vatTreatment]} ${isolate(vatRate(line.vatRateBps))}: ${isolate(money(line.vatAmount))}   ${l.total}: ${isolate(money(line.grossAmount))}`,
    );
    write("");
  }
  field(l.net, money(totals.netAmountMinor));
  field(l.vat, money(totals.vatAmountMinor));
  field(l.total, money(totals.grossAmountMinor));
  for (const legalNote of invoiceLegalNotes(options)) {
    write(legalNote);
  }
  if (seller !== null) {
    // Business register and bar registration lines print as entered.
    for (const line of [seller.registerEntry, seller.barRegistration]) {
      if (line) {
        write(line);
      }
    }
  }
  for (const breakdown of totals.vatBreakdown) {
    write(
      `${treatments[breakdown.vatTreatment]} ${isolate(vatRate(breakdown.vatRateBps))}: ${isolate(money(breakdown.netAmountMinor))} / ${isolate(money(breakdown.vatAmountMinor))}`,
    );
  }
  if (seller !== null) {
    write("");
    write(l.payment);
    field("IBAN", seller.iban);
    field("BIC", seller.bic);
    if (seller.accountNumber !== null) {
      write(seller.accountNumber);
    }
  }
  const payment = buildInvoicePaymentPayload(options);
  if (payment !== null) {
    if (payment.isErr()) {
      return Result.err(payment.error);
    }
    const payable = payment.value;
    if (payable.status === "payable") {
      writeQr(payable.payload);
    }
  }
  if (invoice.notes !== null) {
    write("");
    field(l.notes, invoice.notes);
  }
  if (seller?.footerNotes) {
    write("");
    write(seller.footerNotes);
  }
  finish();
  const saved = await savePdfRewrite({
    pdf,
    source: new Uint8Array(),
    options: { subsetFonts: true },
  });
  switch (saved.status) {
    case "saved":
      return Result.ok(saved.bytes);
    case "signed":
    case "encrypted":
      return panic("New invoice PDF cannot be signed or encrypted");
    default:
      saved satisfies never;
      return panic("Unknown invoice PDF save status");
  }
};
