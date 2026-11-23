import { describe, expect, test } from "bun:test";

import { DOCUMENT_ARCHIVE_MAX_BYTES } from "@/api/lib/files/archive-preview-protocol";
import {
  E_INVOICE_PREVIEW_MAX_JSON_BYTES,
  readEInvoiceFile,
} from "@/api/lib/files/e-invoice-document";
import { E_INVOICE_PREVIEW_MAX_LINES } from "@/api/lib/files/e-invoice-nodes";
import { eInvoiceDocumentText } from "@/api/lib/files/e-invoice-text";
import { listEInvoiceParts } from "@/api/lib/files/e-invoice-worker";
import {
  classifyXmlDocument,
  type XmlDocumentClass,
} from "@/api/lib/files/xml-document-class";
import { parseStandaloneXml } from "@/api/lib/files/xml-document-package";
import {
  ciiXml,
  fatturaPaXml,
  isdocXml,
  isdocxPackage,
  plainXml,
  SAMPLE_ATTACHMENT_TEXT,
  ublXml,
  xadesSignatureXml,
  xmlBytes,
} from "@/api/tests/fixtures/e-invoice";

const read = async (bytes: Uint8Array) => {
  const document = (await readEInvoiceFile(bytes)).unwrap();
  if (document === null) {
    throw new Error("Expected an invoice");
  }
  return document;
};

/** The preview as it leaves the reader, its attachments listed as parts. */
const listed = async (document: Awaited<ReturnType<typeof read>>) =>
  (await listEInvoiceParts(document)).unwrap();

const attachmentText = (
  document: Awaited<ReturnType<typeof read>>,
  index: number,
) =>
  new TextDecoder().decode(
    document.attachments[index]?.read().unwrap() ?? new Uint8Array(),
  );

describe("XML document routing", () => {
  test.each<[string, string, XmlDocumentClass | null]>([
    ["an XAdES signature", xadesSignatureXml(), "xmlSignature"],
    ["a FatturaPA invoice", fatturaPaXml(), "fatturaPA"],
    [
      "an enveloped-signed FatturaPA invoice",
      fatturaPaXml({ signed: true }),
      "fatturaPA",
    ],
    ["an ISDOC invoice", isdocXml(), "isdoc"],
    ["a UBL invoice", ublXml(), "ubl"],
    ["a UBL credit note", ublXml("CreditNote"), "ubl"],
    ["a CII invoice", ciiXml(), "cii"],
    ["plain XML", plainXml(), null],
  ])("routes %s by its root namespace", (_, xml, expected) => {
    const root = parseStandaloneXml(
      xmlBytes(xml),
      DOCUMENT_ARCHIVE_MAX_BYTES,
    ).unwrap();
    expect(classifyXmlDocument(root)).toBe(expected);
  });

  test("an unqualified root named like an invoice stays plain XML", () => {
    const root = parseStandaloneXml(
      xmlBytes("<Invoice><ID>1</ID></Invoice>"),
      DOCUMENT_ARCHIVE_MAX_BYTES,
    ).unwrap();
    expect(classifyXmlDocument(root)).toBeNull();
  });

  test.each([
    ["an XAdES signature", xadesSignatureXml()],
    ["plain XML", plainXml()],
  ])("never reads %s as an invoice", async (_, xml) => {
    expect((await readEInvoiceFile(xmlBytes(xml))).unwrap()).toBeNull();
  });

  test("refuses malformed XML and document type declarations", async () => {
    expect((await readEInvoiceFile(xmlBytes("<Invoice"))).isErr()).toBe(true);
    const withDoctype =
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>';
    expect((await readEInvoiceFile(xmlBytes(withDoctype))).isErr()).toBe(true);
  });
});

describe("structured invoice reading", () => {
  test("reads an ISDOC invoice with parties, lines, VAT, totals and payment", async () => {
    const { preview } = await read(xmlBytes(isdocXml()));
    expect(preview.syntax).toBe("isdoc");
    expect(preview.version).toBe("6.0.2");
    const [invoice] = preview.invoices;
    expect(invoice).toMatchObject({
      documentType: "invoice",
      typeCode: "1",
      number: "FV-2026-0042",
      issueDate: "2026-03-02",
      taxPointDate: "2026-02-28",
      dueDate: "2026-03-16",
      currency: "CZK",
      seller: {
        name: "Example Supplier s.r.o.",
        identifiers: [
          { kind: "registration", scheme: null, value: "00000001" },
          { kind: "vat", scheme: "VAT", value: "CZ00000001" },
        ],
        address: ["Example Street 1", "110 00 Praha", "Czech Republic"],
      },
      buyer: { name: "Example Customer a.s." },
      lineCount: 2,
      vatBreakdown: [
        {
          rate: "21",
          taxableAmount: "6000.00",
          taxAmount: "1260.00",
        },
      ],
      totals: {
        netAmount: "6000.00",
        taxAmount: "1260.00",
        grossAmount: "7260.00",
        prepaidAmount: "0.00",
        payableAmount: "7260.00",
      },
      payments: [
        {
          meansCode: "42",
          amount: "7260.00",
          accountNumber: "000000-0000000001",
          bankCode: "0000",
          iban: "CZ0000000000000000000001",
          bic: "EXAMCZPP",
          reference: "20260042",
        },
      ],
      notes: ["Legal services, February"],
    });
    expect(invoice?.lines[0]).toEqual({
      id: "1",
      description: "Consultation 1",
      quantity: "2",
      unitCode: "HUR",
      unitPrice: "1500.00",
      priceBasis: null,
      vatRate: "21",
      vatCategory: null,
      netAmount: "3000.00",
    });
  });

  test("keeps the line count when a long invoice is cut short", async () => {
    const lines = E_INVOICE_PREVIEW_MAX_LINES + 5;
    const preview = await listed(await read(xmlBytes(isdocXml({ lines }))));
    expect(preview.invoices[0]?.lines).toHaveLength(
      E_INVOICE_PREVIEW_MAX_LINES,
    );
    expect(preview.invoices[0]?.lineCount).toBe(lines);
    expect(eInvoiceDocumentText(preview)).toContain(
      `Lines (${E_INVOICE_PREVIEW_MAX_LINES} of ${lines}):`,
    );
  });

  test.each([true, false])(
    "opens an ISDOCX package and its supplements (manifest %p)",
    async (manifest) => {
      const document = await read(await isdocxPackage({ manifest }));
      expect(document.preview.syntax).toBe("isdoc");
      expect(document.preview.invoices[0]?.number).toBe("FV-2026-0042");
      // The package's path is a claim; the part is named by its base name.
      expect((await listed(document)).attachments).toEqual([
        {
          part: "attachment:0",
          fileName: "delivery-note.txt",
          description: null,
          mediaType: "text/plain",
          sizeBytes: SAMPLE_ATTACHMENT_TEXT.length,
        },
      ]);
      expect(attachmentText(document, 0)).toBe(SAMPLE_ATTACHMENT_TEXT);
    },
  );

  test("reads every invoice of a FatturaPA batch and its embedded attachment", async () => {
    const document = await read(xmlBytes(fatturaPaXml({ bodies: 2 })));
    const { preview } = document;
    expect(preview).toMatchObject({ syntax: "fatturaPA", version: "FPR12" });
    expect(preview.invoices.map(({ number }) => number)).toEqual([
      "2026/1",
      "2026/2",
    ]);
    expect(preview.invoices[0]).toMatchObject({
      documentType: "invoice",
      typeCode: "TD01",
      issueDate: "2026-04-10",
      dueDate: "2026-05-10",
      currency: "EUR",
      seller: {
        name: "Esempio Fornitore S.r.l.",
        identifiers: [
          { kind: "vat", scheme: "IdFiscaleIVA", value: "IT00000000001" },
        ],
        address: ["Via Esempio 1", "00100 Roma (RM)", "IT"],
      },
      buyer: {
        name: "Mario Esempio",
        identifiers: [
          { kind: "tax", scheme: "CodiceFiscale", value: "XXXXXX00X00X000X" },
        ],
      },
      lines: [
        {
          description: "Consulenza",
          quantity: "4.00",
          unitCode: "ore",
          unitPrice: "250.00",
          vatRate: "22.00",
          netAmount: "1000.00",
        },
      ],
      vatBreakdown: [
        { rate: "22.00", taxableAmount: "1000.00", taxAmount: "220.00" },
      ],
      // Only the document total is stated; its parts are never computed.
      totals: { grossAmount: "1220.00", netAmount: null, taxAmount: null },
      payments: [
        {
          meansCode: "MP05",
          amount: "1220.00",
          iban: "IT00X0000000000000000000001",
        },
      ],
      notes: ["Synthetic consulting fees"],
    });
    expect((await listed(document)).attachments).toEqual([
      {
        part: "attachment:0",
        fileName: "bolla.txt",
        description: "Delivery note",
        mediaType: "text/plain",
        sizeBytes: SAMPLE_ATTACHMENT_TEXT.length,
      },
    ]);
    expect(attachmentText(document, 0)).toBe(SAMPLE_ATTACHMENT_TEXT);
  });

  test("reads a UBL invoice and a UBL credit note", async () => {
    const invoice = await read(xmlBytes(ublXml()));
    expect(invoice.preview).toMatchObject({
      syntax: "ubl",
      version:
        "urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0",
    });
    expect(invoice.preview.invoices[0]).toMatchObject({
      documentType: "invoice",
      typeCode: "380",
      number: "UBL-0007",
      dueDate: "2026-06-03",
      currency: "EUR",
      seller: {
        name: "Beispiel Lieferant GmbH",
        identifiers: [
          { kind: "vat", scheme: "VAT", value: "DE000000001" },
          { kind: "registration", scheme: "0002", value: "HRB 00000" },
          { kind: "other", scheme: "0088", value: "0000000000001" },
        ],
        address: ["Musterweg 1", "10115 Berlin", "DE"],
      },
      lines: [
        {
          description: "Synthetic widget",
          quantity: "10",
          unitCode: "C62",
          unitPrice: "1.00",
          priceBasis: "0.1 C62",
          vatRate: "19",
          vatCategory: "S",
          netAmount: "100.00",
        },
      ],
      totals: {
        netAmount: "100.00",
        taxAmount: "19.00",
        grossAmount: "119.00",
        payableAmount: "119.00",
      },
      payments: [
        {
          meansCode: "58",
          iban: "DE00000000000000000001",
          bic: "EXAMDEFF",
          reference: "UBL-0007",
        },
      ],
    });
    expect(attachmentText(invoice, 0)).toBe(SAMPLE_ATTACHMENT_TEXT);
    expect((await listed(invoice)).attachments[0]).toMatchObject({
      fileName: "delivery-note.txt",
      description: "Delivery note",
    });

    const credit = await read(xmlBytes(ublXml("CreditNote")));
    expect(credit.preview.invoices[0]).toMatchObject({
      documentType: "creditNote",
      typeCode: "381",
      lines: [{ quantity: "10" }],
    });
  });

  test("reads a CII invoice and writes its compact dates as calendar dates", async () => {
    const { preview } = await read(xmlBytes(ciiXml()));
    expect(preview).toMatchObject({
      syntax: "cii",
      version: "urn:cen.eu:en16931:2017",
    });
    expect(preview.invoices[0]).toMatchObject({
      documentType: "invoice",
      number: "CII-0099",
      issueDate: "2026-06-07",
      dueDate: "2026-07-07",
      currency: "EUR",
      seller: {
        name: "Exemple Vendeur SAS",
        identifiers: [
          { kind: "vat", scheme: "VA", value: "FR00000000001" },
          { kind: "registration", scheme: "0002", value: "00000000000000" },
        ],
      },
      buyer: { name: "Exemple Client SARL" },
      lines: [
        {
          id: "1",
          description: "Synthetic licence",
          quantity: "2",
          unitPrice: "50.00",
          vatRate: "20",
          netAmount: "100.00",
        },
      ],
      vatBreakdown: [
        {
          rate: "20",
          category: "S",
          taxableAmount: "100.00",
          taxAmount: "20.00",
        },
      ],
      totals: {
        netAmount: "100.00",
        taxAmount: "20.00",
        grossAmount: "120.00",
        payableAmount: "120.00",
      },
      payments: [
        {
          meansCode: "58",
          iban: "FR0000000000000000000000001",
          reference: "CII-0099",
          dueDate: "2026-07-07",
        },
      ],
      notes: ["Synthetic subscription"],
    });
  });

  test("shows only an IBAN as one and keeps another account identifier", async () => {
    const { preview } = await read(
      xmlBytes(ublXml("Invoice", { accountId: "0000000001" })),
    );
    expect(preview.invoices[0]?.payments[0]).toMatchObject({
      iban: null,
      accountNumber: "0000000001",
    });
  });

  test("keeps a large invoice's preview within its byte budget", async () => {
    const lines = E_INVOICE_PREVIEW_MAX_LINES;
    const { preview } = await read(
      xmlBytes(ublXml("Invoice", { lines, description: "w".repeat(6000) })),
    );
    const [invoice] = preview.invoices;
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThanOrEqual(
      E_INVOICE_PREVIEW_MAX_JSON_BYTES,
    );
    expect(invoice?.lineCount).toBe(lines);
    expect(invoice?.lines.length).toBeGreaterThan(0);
    expect(invoice?.lines.length).toBeLessThan(lines);
    expect(invoice?.totals.payableAmount).toBe("119.00");
  });

  test("refuses an invoice that cannot fit without dropping more than lines", async () => {
    const notes = `<cbc:Note>${"n".repeat(9000)}</cbc:Note>`.repeat(400);
    const xml = ublXml().replace(
      "<cbc:Note>Synthetic order 7</cbc:Note>",
      () => notes,
    );
    const refused = await readEInvoiceFile(xmlBytes(xml));
    expect(refused.isErr() && refused.error).toMatchObject({
      reason: "limit",
    });
  });

  test("never drops an invoice of a batch to fit it", async () => {
    const bodies = 40;
    const { preview } = await read(xmlBytes(fatturaPaXml({ bodies })));
    expect(preview.invoices).toHaveLength(bodies);
  });

  test("search and AI text carries the same fields the preview shows", async () => {
    const text = eInvoiceDocumentText(
      await listed(await read(xmlBytes(isdocXml()))),
    );
    for (const value of [
      "ISDOC structured invoice, 6.0.2.",
      "Invoice FV-2026-0042 (type 1)",
      "Seller: Example Supplier s.r.o.",
      "VAT ID (VAT): CZ00000001",
      "Buyer: Example Customer a.s.",
      "1. Consultation 1; quantity 2 HUR; unit price 1500.00; VAT 21; net 3000.00 CZK",
      "Totals: net 6000.00 CZK; VAT 1260.00 CZK; gross 7260.00 CZK",
      "IBAN CZ0000000000000000000001",
      "reference 20260042",
    ]) {
      expect(text).toContain(value);
    }
  });
});
