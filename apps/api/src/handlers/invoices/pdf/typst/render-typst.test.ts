import { PDF, PdfArray, PdfDict, PdfName, PdfStream } from "@libpdf/core";
import { afterAll, describe, expect, test } from "bun:test";
import { encode } from "uqr";

import { buildInvoicePaymentPayload } from "../render-helpers";
import { buildInvoiceTemplateData, qrSvg } from "./data";
import { CEE_DIACRITICS, DUMMY_ISDOC, invoiceFixture } from "./fixtures";
import { PDFA_PRODUCER } from "./pdfa";
import { renderInvoiceWithTypst } from "./render-typst";
import { openTypstSession } from "./session";

const session = openTypstSession();
afterAll(async () => {
  await session.close();
});

const CREATED_AT = new Date("2026-09-30T08:00:00Z");
const isdoc = {
  name: "invoice.isdoc",
  bytes: new TextEncoder().encode(DUMMY_ISDOC),
  mimeType: "application/xml",
  description: "ISDOC",
  relationship: "Alternative",
} as const;

// Extraction may turn the no-break spaces of formatted amounts into spaces.
const spaces = (value: string) => value.replaceAll(/[\u00A0\u202F]/gu, " ");

const render = async (lineCount: number) => {
  const outcome = (
    await renderInvoiceWithTypst({
      invoice: invoiceFixture(lineCount),
      session,
      attachments: [isdoc],
      createdAt: CREATED_AT,
    })
  ).unwrap();
  if (outcome.status !== "rendered") {
    throw new Error(outcome.diagnostics.join("\n"));
  }
  const pdf = await PDF.load(outcome.pdf);
  return {
    pdf,
    pages: pdf.extractText().map(({ text }) => spaces(text)),
  };
};

describe("Typst invoice renderer", () => {
  test("prints every field the live renderer prints", async () => {
    const fixture = invoiceFixture(3);
    const data = buildInvoiceTemplateData(fixture).unwrap();
    const { pages } = await render(3);
    const text = pages.join("\n");
    const expected = [
      data.title,
      // Meta labels may wrap inside their cell; their values do not.
      ...data.meta.map(({ value }) => value),
      ...(data.seller === null
        ? []
        : [
            data.seller.heading,
            data.seller.name ?? "",
            ...data.seller.address,
            ...data.seller.ids.map(({ value }) => value),
          ]),
      data.buyer.heading,
      data.buyer.name ?? "",
      ...data.buyer.address,
      ...data.buyer.ids.map(({ value }) => value),
      data.totals.net,
      data.totals.vat,
      data.totals.gross,
      ...(data.payment?.fields.map(({ value }) => value) ?? []),
      data.payment?.accountNumber ?? "",
      data.footerNotes ?? "",
    ];
    // Typst prints labels in small caps through `upper`; compare case-free.
    const folded = text.toLocaleLowerCase("cs");
    for (const value of expected) {
      expect(folded).toContain(spaces(value).toLocaleLowerCase("cs"));
    }
    for (const line of data.lines) {
      expect(text).toContain(spaces(line.total));
      expect(text).toContain(spaces(line.quantity ?? ""));
    }
  });

  test("round-trips Central European diacritics through text extraction", async () => {
    const { pages } = await render(1);
    expect(pages.join("\n")).toContain(CEE_DIACRITICS);
  });

  test("breaks 60 lines over pages and repeats the table header on each", async () => {
    const data = buildInvoiceTemplateData(invoiceFixture(60)).unwrap();
    const { pdf, pages } = await render(60);
    expect(pdf.getPageCount()).toBeGreaterThan(2);
    const header = data.labels.description.toLocaleUpperCase("cs");
    const lineTotal = spaces(data.lines[0]?.total ?? "missing");
    const pagesWithLines = pages.filter((page) => page.includes(lineTotal));
    expect(pagesWithLines.length).toBeGreaterThan(2);
    for (const page of pagesWithLines) {
      expect(page).toContain(header);
    }
    expect(pages.at(-1)).toContain(
      `${String(pdf.getPageCount())} / ${String(pdf.getPageCount())}`,
    );
  });

  test("writes PDF/A-3b identification, an sRGB output intent and the ISDOC attachment", async () => {
    const { pdf } = await render(1);
    const resolve = (ref: Parameters<typeof pdf.getObject>[0]) =>
      pdf.getObject(ref);
    const catalog = pdf.getCatalog();

    const metadata = catalog.get("Metadata", resolve);
    expect(metadata).toBeInstanceOf(PdfStream);
    const xmp = new TextDecoder().decode(
      metadata instanceof PdfStream ? metadata.data : new Uint8Array(),
    );
    expect(xmp).toContain("<pdfaid:part>3</pdfaid:part>");
    expect(xmp).toContain("<pdfaid:conformance>B</pdfaid:conformance>");
    expect(xmp).toContain(`<pdf:Producer>${PDFA_PRODUCER}</pdf:Producer>`);
    expect(pdf.getProducer()).toBe(PDFA_PRODUCER);
    expect(pdf.getCreationDate()?.toISOString()).toBe(CREATED_AT.toISOString());

    const intent = catalog.getArray("OutputIntents", resolve)?.at(0, resolve);
    expect(intent).toBeInstanceOf(PdfDict);
    expect(
      intent instanceof PdfDict ? intent.getName("S")?.value : undefined,
    ).toBe("GTS_PDFA1");

    expect(
      new TextDecoder().decode(
        pdf.attachments.get(isdoc.name) ?? new Uint8Array(),
      ),
    ).toBe(DUMMY_ISDOC);
    const associated = catalog.getArray("AF", resolve);
    expect(associated).toBeInstanceOf(PdfArray);
    const spec = associated?.at(0, resolve);
    expect(spec).toBeInstanceOf(PdfDict);
    if (spec instanceof PdfDict) {
      expect(spec.getName("AFRelationship")?.value).toBe("Alternative");
      const file = spec.getDict("EF", resolve)?.get("F", resolve);
      expect(file).toBeInstanceOf(PdfStream);
      if (file instanceof PdfStream) {
        expect(file.get("Subtype")).toEqual(PdfName.of("application/xml"));
      }
    }
  });
});

describe("payment QR as SVG", () => {
  test("the SVG paths reproduce the encoder's module matrix exactly", () => {
    const payment = buildInvoicePaymentPayload(invoiceFixture(1));
    expect(payment).not.toBeNull();
    const payload = payment?.unwrap();
    if (payload?.status !== "payable") {
      throw new Error("Fixture must be payable");
    }
    const qr = encode(payload.payload, { border: 4, ecc: "M" });
    const svg = qrSvg(payload.payload);
    const drawn = qr.data.map((row) => row.map(() => false));
    for (const [, x, y, width] of svg.matchAll(/M(\d+) (\d+)h(\d+)/gu)) {
      for (let column = 0; column < Number(width); column += 1) {
        const row = drawn[Number(y)];
        if (row === undefined) {
          throw new Error("Run outside the matrix");
        }
        row[Number(x) + column] = true;
      }
    }
    expect(drawn).toEqual(qr.data);
    expect(svg).toContain(
      `viewBox="0 0 ${String(qr.size)} ${String(qr.size)}"`,
    );
  });

  test("a credit note carries no QR code", () => {
    const fixture = invoiceFixture(1);
    const data = buildInvoiceTemplateData({
      ...fixture,
      invoice: { ...fixture.invoice, documentType: "credit_note" },
    }).unwrap();
    expect(data.payment?.qrSvg).toBeNull();
  });
});

describe("Typst country invoice wording", () => {
  test.each(["sk", "en"] as const)(
    "extracts mandated Slovak reverse-charge wording in %s",
    async (lang) => {
      const fixture = invoiceFixture(1);
      const sourceLine = fixture.invoice.lines.at(0);
      if (sourceLine === undefined) {
        throw new Error("Fixture must contain an invoice line");
      }
      const input = {
        ...fixture,
        seller: { ...fixture.seller, country: "SK", vatId: "SK1234567890" },
        invoice: {
          ...fixture.invoice,
          language: lang,
          lines: [{ ...sourceLine, vatTreatment: "reverse_charge" as const }],
        },
      };
      const outcome = (
        await renderInvoiceWithTypst({
          invoice: input,
          session,
          attachments: [isdoc],
          createdAt: CREATED_AT,
        })
      ).unwrap();
      if (outcome.status !== "rendered") {
        throw new Error(outcome.diagnostics.join("\n"));
      }
      const text = (await PDF.load(outcome.pdf))
        .extractText()
        .map((page) => page.text)
        .join("\n");
      expect(text).toContain("Prenesenie daňovej povinnosti.");
    },
  );

  test("extracts a Slovak exemption reason", async () => {
    const fixture = invoiceFixture(1);
    const sourceLine = fixture.invoice.lines.at(0);
    if (sourceLine === undefined) {
      throw new Error("Fixture must contain an invoice line");
    }
    const input = {
      ...fixture,
      seller: { ...fixture.seller, country: "SK", vatId: "SK1234567890" },
      invoice: {
        ...fixture.invoice,
        language: "en" as const,
        lines: [
          {
            ...sourceLine,
            vatTreatment: "exempt" as const,
            exemptionReason: "§ 38",
          },
        ],
      },
    };
    const outcome = (
      await renderInvoiceWithTypst({
        invoice: input,
        session,
        attachments: [isdoc],
        createdAt: CREATED_AT,
      })
    ).unwrap();
    if (outcome.status !== "rendered") {
      throw new Error(outcome.diagnostics.join("\n"));
    }
    const text = (await PDF.load(outcome.pdf))
      .extractText()
      .map((page) => page.text)
      .join("\n");
    expect(text).toContain("Dodanie je oslobodené od dane.");
    expect(text).toContain("§ 38");
  });
});

test("Slovak payment documents carry the complete official print mark at its recommended size", () => {
  const fixture = invoiceFixture(1);
  const slovak = buildInvoiceTemplateData({
    ...fixture,
    seller: {
      ...fixture.seller,
      iban: "SK2711000000123456789012",
      country: "SK",
      bic: "FIKTSKBA",
    },
    invoice: { ...fixture.invoice, currency: "EUR", language: "sk" },
  }).unwrap();
  expect(slovak.payment?.qrWidthMm).toBe(37.254);
  expect(slovak.payment?.qrSvg).toContain('viewBox="0 0 64 75"');
  for (const id of ["g3522-3", "g3493-4", "g3487-0"]) {
    expect(slovak.payment?.qrSvg).toContain(`id="${id}"`);
  }
  const czech = buildInvoiceTemplateData(fixture).unwrap();
  expect(czech.payment?.qrWidthMm).toBe(32);
  expect(czech.payment?.qrSvg).not.toContain('id="g3522-3"');
});
