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

import type { InvoiceStatus } from "@stll/api-contract";
import { buildCzechQrPaymentPayload } from "@stll/invoicing";
import type {
  InvoiceDocumentType,
  InvoiceTotals,
  VatTreatment,
} from "@stll/invoicing";
import { formatMoneyCents } from "@stll/money";
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
import type { SupportedLang } from "@/api/lib/locale";

export type RenderInvoicePdfOptions = {
  invoice: {
    status: InvoiceStatus;
    documentType: InvoiceDocumentType;
    invoiceNumber: string | null;
    invoiceDate: string;
    dueDate: string | null;
    taxableSupplyDate: string | null;
    currency: string;
    reference: string | null;
    notes: string | null;
    buyerName: string | null;
    buyerRegistrationId: string | null;
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
    }[];
  };
  seller: {
    legalName: string;
    registrationId: string | null;
    vatId: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    postalCode: string | null;
    country: string | null;
    iban: string | null;
    bic: string | null;
    accountNumber: string | null;
    footerNotes: string | null;
  } | null;
  totals: InvoiceTotals;
  originalNumber: string | null;
  locale: string;
  lang: SupportedLang;
};

const EN_LABELS = {
  invoice: "Invoice",
  advance: "Advance invoice",
  credit: "Credit note",
  draft: "Draft",
  seller: "Seller",
  buyer: "Buyer",
  issueDate: "Issue date",
  dueDate: "Due date",
  taxDate: "Taxable supply date",
  reference: "Reference",
  original: "Original invoice",
  net: "Net",
  vat: "VAT",
  total: "Total",
  registration: "Registration ID",
  vatId: "VAT ID",
  description: "Description",
  quantity: "Quantity",
  unitPrice: "Unit price",
  payment: "Payment",
  notes: "Notes",
  reverse: "Reverse charge",
  exempt: "Exempt",
  nonPayer: "Not a VAT payer",
} as const;
const LABELS = {
  en: EN_LABELS,
  cs: {
    invoice: "Faktura",
    advance: "Zálohová faktura",
    credit: "Dobropis",
    draft: "Koncept",
    seller: "Dodavatel",
    buyer: "Odběratel",
    issueDate: "Datum vystavení",
    dueDate: "Datum splatnosti",
    taxDate: "Datum zdanitelného plnění",
    reference: "Reference",
    original: "Původní faktura",
    net: "Základ",
    vat: "DPH",
    total: "Celkem",
    registration: "IČO",
    vatId: "DIČ",
    description: "Popis",
    quantity: "Množství",
    unitPrice: "Jednotková cena",
    payment: "Platba",
    notes: "Poznámky",
    reverse: "Přenesení daňové povinnosti",
    exempt: "Osvobozeno",
    nonPayer: "Neplátce DPH",
  },
  sk: {
    invoice: "Faktúra",
    advance: "Zálohová faktúra",
    credit: "Dobropis",
    draft: "Koncept",
    seller: "Dodávateľ",
    buyer: "Odberateľ",
    issueDate: "Dátum vystavenia",
    dueDate: "Dátum splatnosti",
    taxDate: "Dátum zdaniteľného plnenia",
    reference: "Referencia",
    original: "Pôvodná faktúra",
    net: "Základ",
    vat: "DPH",
    total: "Spolu",
    registration: "IČO",
    vatId: "IČ DPH",
    description: "Popis",
    quantity: "Množstvo",
    unitPrice: "Jednotková cena",
    payment: "Platba",
    notes: "Poznámky",
    reverse: "Prenesenie daňovej povinnosti",
    exempt: "Oslobodené",
    nonPayer: "Neplatiteľ DPH",
  },
  de: {
    invoice: "Rechnung",
    advance: "Vorauszahlungsrechnung",
    credit: "Gutschrift",
    draft: "Entwurf",
    seller: "Verkäufer",
    buyer: "Käufer",
    issueDate: "Ausstellungsdatum",
    dueDate: "Fälligkeitsdatum",
    taxDate: "Leistungsdatum",
    reference: "Referenz",
    original: "Ursprüngliche Rechnung",
    net: "Netto",
    vat: "Umsatzsteuer",
    total: "Gesamt",
    registration: "Registrierungsnummer",
    vatId: "USt-IdNr.",
    description: "Beschreibung",
    quantity: "Menge",
    unitPrice: "Einzelpreis",
    payment: "Zahlung",
    notes: "Anmerkungen",
    reverse: "Steuerschuldnerschaft des Leistungsempfängers",
    exempt: "Steuerbefreit",
    nonPayer: "Nicht umsatzsteuerpflichtig",
  },
  fr: {
    invoice: "Facture",
    advance: "Facture d’acompte",
    credit: "Avoir",
    draft: "Brouillon",
    seller: "Vendeur",
    buyer: "Acheteur",
    issueDate: "Date d’émission",
    dueDate: "Date d’échéance",
    taxDate: "Date de livraison",
    reference: "Référence",
    original: "Facture d’origine",
    net: "Hors taxe",
    vat: "TVA",
    total: "Total",
    registration: "Numéro d’immatriculation",
    vatId: "Numéro de TVA",
    description: "Description",
    quantity: "Quantité",
    unitPrice: "Prix unitaire",
    payment: "Paiement",
    notes: "Notes",
    reverse: "Autoliquidation",
    exempt: "Exonéré",
    nonPayer: "Non assujetti à la TVA",
  },
  es: {
    invoice: "Factura",
    advance: "Factura de anticipo",
    credit: "Factura rectificativa",
    draft: "Borrador",
    seller: "Vendedor",
    buyer: "Comprador",
    issueDate: "Fecha de emisión",
    dueDate: "Fecha de vencimiento",
    taxDate: "Fecha de operación",
    reference: "Referencia",
    original: "Factura original",
    net: "Base imponible",
    vat: "IVA",
    total: "Total",
    registration: "Número de registro",
    vatId: "Número de IVA",
    description: "Descripción",
    quantity: "Cantidad",
    unitPrice: "Precio unitario",
    payment: "Pago",
    notes: "Notas",
    reverse: "Inversión del sujeto pasivo",
    exempt: "Exento",
    nonPayer: "No sujeto al IVA",
  },
  "pt-BR": {
    invoice: "Fatura",
    advance: "Fatura de adiantamento",
    credit: "Nota de crédito",
    draft: "Rascunho",
    seller: "Vendedor",
    buyer: "Comprador",
    issueDate: "Data de emissão",
    dueDate: "Data de vencimento",
    taxDate: "Data da operação",
    reference: "Referência",
    original: "Fatura original",
    net: "Valor líquido",
    vat: "IVA",
    total: "Total",
    registration: "Número de registro",
    vatId: "Número de IVA",
    description: "Descrição",
    quantity: "Quantidade",
    unitPrice: "Preço unitário",
    payment: "Pagamento",
    notes: "Observações",
    reverse: "Inversão do sujeito passivo",
    exempt: "Isento",
    nonPayer: "Não contribuinte do IVA",
  },
  pl: {
    invoice: "Faktura",
    advance: "Faktura zaliczkowa",
    credit: "Faktura korygująca",
    draft: "Wersja robocza",
    seller: "Sprzedawca",
    buyer: "Nabywca",
    issueDate: "Data wystawienia",
    dueDate: "Termin płatności",
    taxDate: "Data dostawy",
    reference: "Numer referencyjny",
    original: "Faktura pierwotna",
    net: "Netto",
    vat: "VAT",
    total: "Razem",
    registration: "Numer rejestracyjny",
    vatId: "Numer VAT",
    description: "Opis",
    quantity: "Ilość",
    unitPrice: "Cena jednostkowa",
    payment: "Płatność",
    notes: "Uwagi",
    reverse: "Odwrotne obciążenie",
    exempt: "Zwolnione",
    nonPayer: "Nie jest podatnikiem VAT",
  },
  hu: {
    invoice: "Számla",
    advance: "Előlegszámla",
    credit: "Jóváíró számla",
    draft: "Piszkozat",
    seller: "Eladó",
    buyer: "Vevő",
    issueDate: "Kiállítás dátuma",
    dueDate: "Fizetési határidő",
    taxDate: "Teljesítés dátuma",
    reference: "Hivatkozás",
    original: "Eredeti számla",
    net: "Nettó",
    vat: "ÁFA",
    total: "Összesen",
    registration: "Nyilvántartási szám",
    vatId: "ÁFA-szám",
    description: "Leírás",
    quantity: "Mennyiség",
    unitPrice: "Egységár",
    payment: "Fizetés",
    notes: "Megjegyzések",
    reverse: "Fordított adózás",
    exempt: "Adómentes",
    nonPayer: "Nem ÁFA-alany",
  },
  et: {
    invoice: "Arve",
    advance: "Ettemaksuarve",
    credit: "Kreeditarve",
    draft: "Mustand",
    seller: "Müüja",
    buyer: "Ostja",
    issueDate: "Väljastamise kuupäev",
    dueDate: "Maksetähtpäev",
    taxDate: "Tarne kuupäev",
    reference: "Viide",
    original: "Algne arve",
    net: "Netosumma",
    vat: "Käibemaks",
    total: "Kokku",
    registration: "Registrikood",
    vatId: "KMKR number",
    description: "Kirjeldus",
    quantity: "Kogus",
    unitPrice: "Ühikuhind",
    payment: "Makse",
    notes: "Märkused",
    reverse: "Pöördmaksustamine",
    exempt: "Maksuvaba",
    nonPayer: "Ei ole käibemaksukohustuslane",
  },
  lv: {
    invoice: "Rēķins",
    advance: "Avansa rēķins",
    credit: "Kredītrēķins",
    draft: "Melnraksts",
    seller: "Pārdevējs",
    buyer: "Pircējs",
    issueDate: "Izrakstīšanas datums",
    dueDate: "Apmaksas termiņš",
    taxDate: "Piegādes datums",
    reference: "Atsauce",
    original: "Sākotnējais rēķins",
    net: "Neto",
    vat: "PVN",
    total: "Kopā",
    registration: "Reģistrācijas numurs",
    vatId: "PVN numurs",
    description: "Apraksts",
    quantity: "Daudzums",
    unitPrice: "Vienības cena",
    payment: "Maksājums",
    notes: "Piezīmes",
    reverse: "Apgrieztā maksāšana",
    exempt: "Atbrīvots",
    nonPayer: "Nav PVN maksātājs",
  },
  lt: {
    invoice: "Sąskaita",
    advance: "Avansinė sąskaita",
    credit: "Kreditinė sąskaita",
    draft: "Juodraštis",
    seller: "Pardavėjas",
    buyer: "Pirkėjas",
    issueDate: "Išrašymo data",
    dueDate: "Mokėjimo terminas",
    taxDate: "Tiekimo data",
    reference: "Nuoroda",
    original: "Pradinė sąskaita",
    net: "Neto",
    vat: "PVM",
    total: "Iš viso",
    registration: "Registracijos numeris",
    vatId: "PVM numeris",
    description: "Aprašymas",
    quantity: "Kiekis",
    unitPrice: "Vieneto kaina",
    payment: "Mokėjimas",
    notes: "Pastabos",
    reverse: "Atvirkštinis apmokestinimas",
    exempt: "Neapmokestinama",
    nonPayer: "Ne PVM mokėtojas",
  },
  ar: {
    invoice: "فاتورة",
    advance: "فاتورة مقدمة",
    credit: "إشعار دائن",
    draft: "مسودة",
    seller: "البائع",
    buyer: "المشتري",
    issueDate: "تاريخ الإصدار",
    dueDate: "تاريخ الاستحقاق",
    taxDate: "تاريخ التوريد",
    reference: "مرجع",
    original: "الفاتورة الأصلية",
    net: "الصافي",
    vat: "ضريبة القيمة المضافة",
    total: "الإجمالي",
    registration: "رقم التسجيل",
    vatId: "الرقم الضريبي",
    description: "الوصف",
    quantity: "الكمية",
    unitPrice: "سعر الوحدة",
    payment: "الدفع",
    notes: "ملاحظات",
    reverse: "الاحتساب العكسي",
    exempt: "معفى",
    nonPayer: "غير مسجل في ضريبة القيمة المضافة",
  },
} satisfies Record<SupportedLang, Record<keyof typeof EN_LABELS, string>>;

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
  return buildCzechQrPaymentPayload({
    documentType: invoice.documentType,
    iban: seller.iban,
    amountMinor: totals.grossAmountMinor,
    currency: invoice.currency,
    ...(invoice.dueDate === null ? {} : { dueDate: invoice.dueDate }),
    ...(invoice.reference !== null && /^\d{1,10}$/u.test(invoice.reference)
      ? { variableSymbol: invoice.reference }
      : {}),
    ...(invoice.status === "draft" || invoice.invoiceNumber === null
      ? {}
      : { message: invoice.invoiceNumber }),
  });
};

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 42;
const FONT_SIZE = 10;
const LINE_HEIGHT = 15;
const QR_SIZE = 120;

type ShapedRow = Parameters<typeof drawStampRows>[0]["rows"][number];
type InvoiceWriterOptions = { pdf: PDF; lang: SupportedLang };
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

export const renderInvoicePdf = async (options: RenderInvoicePdfOptions) => {
  const { invoice, seller, totals, locale, lang, originalNumber } = options;
  const l = LABELS[lang];
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
  const money = (amountCents: number) =>
    formatMoneyCents({ amountCents, currency: invoice.currency, locale });
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
  const treatments = {
    domestic_vat: l.vat,
    reverse_charge: l.reverse,
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
    field(l.taxDate, date(invoice.taxableSupplyDate));
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
    field(l.registration, seller.registrationId);
    field(l.vatId, seller.vatId);
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
  field(l.registration, invoice.buyerRegistrationId);
  field(l.vatId, invoice.buyerVatId);
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
