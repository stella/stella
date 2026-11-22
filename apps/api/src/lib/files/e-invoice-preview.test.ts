import { describe, expect, test } from "bun:test";

import {
  CADES_FILE_FORMAT,
  ISDOC_FILE_FORMAT,
  ISDOCX_FILE_FORMAT,
  XML_FILE_FORMAT,
} from "@stll/api-contract/legal-file-formats";

import { readCadesPreview } from "@/api/lib/files/cades-preview";
import {
  readEInvoiceAttachment,
  readEInvoicePreview,
} from "@/api/lib/files/e-invoice-preview";
import {
  eInvoiceDocumentText,
  xmlDocumentPreviewText,
} from "@/api/lib/files/e-invoice-text";
import { extractFileTextResult } from "@/api/lib/search/extract-content";
import {
  fatturaPaXml,
  isdocXml,
  isdocxPackage,
  plainXml,
  SAMPLE_ATTACHMENT_TEXT,
  ublXml,
  xadesSignatureXml,
  xmlBytes,
} from "@/api/tests/fixtures/e-invoice";
import { wrapP7m } from "@/api/tests/fixtures/p7m";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

const storedFile = (bytes: Uint8Array, mimeType: string, fileName: string) =>
  testScannedFile({
    bytes: new Uint8Array(bytes).buffer,
    mimeType,
    path: `org/matter/${fileName}`,
  });

describe("structured invoice files", () => {
  test.each([
    {
      name: "an ISDOC file",
      bytes: async () => xmlBytes(isdocXml()),
      file: "faktura.isdoc",
      mimeType: ISDOC_FILE_FORMAT.mimeType,
      declared: "application/octet-stream",
    },
    {
      name: "an ISDOCX package",
      bytes: isdocxPackage,
      file: "faktura.isdocx",
      mimeType: ISDOCX_FILE_FORMAT.mimeType,
      declared: "application/octet-stream",
    },
    {
      name: "a FatturaPA XML upload",
      bytes: async () => xmlBytes(fatturaPaXml()),
      file: "IT00000000001_00001.xml",
      mimeType: XML_FILE_FORMAT.mimeType,
      declared: "text/xml",
    },
    {
      name: "a UBL XML upload",
      bytes: async () => xmlBytes(ublXml()),
      file: "invoice.xml",
      mimeType: XML_FILE_FORMAT.mimeType,
      declared: "application/xml",
    },
  ])(
    "previews $name and gives search the same text",
    async ({ bytes, file, mimeType, declared }) => {
      const source = await bytes();
      const preview = (
        await readEInvoicePreview(storedFile(source, mimeType, file))
      ).unwrap();
      expect(
        preview.type === "invoice" && preview.invoice.invoices.length,
      ).toBeGreaterThan(0);
      const extracted = await extractFileTextResult(
        storedFile(source, declared, file),
      );
      expect(extracted.unwrap()).toBe(xmlDocumentPreviewText(preview));
    },
  );

  test.each([
    ["plain XML", plainXml(), "<item>Not an invoice</item>"],
    ["an XAdES signature", xadesSignatureXml(), "<SignatureValue>AAAA"],
  ])(
    "shows %s as its indented text, never as an invoice",
    async (_, xml, expected) => {
      const preview = (
        await readEInvoicePreview(
          storedFile(xmlBytes(xml), XML_FILE_FORMAT.mimeType, "data.xml"),
        )
      ).unwrap();
      expect(preview).toMatchObject({ type: "xml", truncated: false });
      expect(preview.type === "xml" && preview.text).toContain(expected);
      const extracted = await extractFileTextResult(
        storedFile(xmlBytes(xml), "text/xml", "data.xml"),
      );
      expect(extracted.unwrap()).toBe(xmlDocumentPreviewText(preview));
    },
  );

  test("shows XML the bounded parser refuses as the text it holds", async () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE note SYSTEM "note.dtd"><note>Kept as text</note>';
    const preview = (
      await readEInvoicePreview(
        storedFile(xmlBytes(xml), XML_FILE_FORMAT.mimeType, "note.xml"),
      )
    ).unwrap();
    expect(preview).toEqual({ type: "xml", text: xml, truncated: false });
  });

  test("an ISDOC file that is not text is refused as unreadable", async () => {
    const file = storedFile(
      new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0xc3, 0x28]),
      ISDOC_FILE_FORMAT.mimeType,
      "broken.isdoc",
    );
    const preview = await readEInvoicePreview(file);
    expect(preview.isErr() && preview.error).toMatchObject({
      status: 422,
      code: "preview_unavailable",
      message: "The invoice file could not be read",
    });
    expect((await extractFileTextResult(file)).isErr()).toBe(true);
  });

  test("opens an attachment after scanning it, with its type from its bytes", async () => {
    const file = storedFile(
      xmlBytes(fatturaPaXml()),
      XML_FILE_FORMAT.mimeType,
      "IT00000000001_00001.xml",
    );
    const attachment = (await readEInvoiceAttachment(0)(file)).unwrap();
    expect(attachment).toMatchObject({
      fileName: "bolla.txt",
      mimeType: "text/plain",
    });
    expect(new TextDecoder().decode(attachment.bytes)).toBe(
      SAMPLE_ATTACHMENT_TEXT,
    );
    const missing = await readEInvoiceAttachment(1)(file);
    expect(missing.isErr() && missing.error.status).toBe(404);
  });

  test("a signed FatturaPA .xml.p7m is read by the CAdES reader, then as an invoice", async () => {
    const name = "IT00000000001_00002.xml.p7m";
    const file = storedFile(
      await wrapP7m(xmlBytes(fatturaPaXml())),
      CADES_FILE_FORMAT.mimeType,
      name,
    );
    const preview = (await readCadesPreview(file, name)).unwrap();
    expect(preview.fileName).toBe("IT00000000001_00002.xml");
    expect(preview.layers).toHaveLength(1);
    expect(preview.invoice?.syntax).toBe("fatturaPA");
    expect(preview.invoice?.invoices[0]?.number).toBe("2026/1");
    if (preview.invoice === null) {
      throw new Error("Expected the signed invoice");
    }
    expect(preview.text).toBe(eInvoiceDocumentText(preview.invoice));
    expect((await extractFileTextResult(file)).unwrap()).toContain(
      eInvoiceDocumentText(preview.invoice),
    );

    const attachment = (await readEInvoiceAttachment(0)(file)).unwrap();
    expect(new TextDecoder().decode(attachment.bytes)).toBe(
      SAMPLE_ATTACHMENT_TEXT,
    );
  });

  test.each([
    [
      "opens with a comment",
      xmlBytes(
        fatturaPaXml().replace("?>", "?><!-- issued by a test system -->"),
      ),
    ],
    [
      "is UTF-16",
      new Uint8Array(
        Buffer.concat([
          Buffer.from([0xff, 0xfe]),
          Buffer.from(
            fatturaPaXml().replace('encoding="UTF-8"', 'encoding="UTF-16"'),
            "utf16le",
          ),
        ]),
      ),
    ],
  ])("a signed invoice that %s opens as it does unsigned", async (_, bytes) => {
    const name = "IT00000000001_00003.xml.p7m";
    const file = storedFile(
      await wrapP7m(bytes),
      CADES_FILE_FORMAT.mimeType,
      name,
    );
    const preview = (await readCadesPreview(file, name)).unwrap();
    expect(preview.invoice?.invoices[0]?.number).toBe("2026/1");
    const unsigned = (
      await readEInvoicePreview(
        storedFile(bytes, XML_FILE_FORMAT.mimeType, "IT00000000001_00003.xml"),
      )
    ).unwrap();
    if (preview.invoice === null) {
      throw new Error("The signed invoice did not preview");
    }
    expect(unsigned).toEqual({ type: "invoice", invoice: preview.invoice });
  });

  test("a signed invoice too large to list in full still previews with its signers", async () => {
    const name = "large-invoice.xml.p7m";
    const file = storedFile(
      await wrapP7m(
        xmlBytes(
          ublXml("Invoice", { lines: 1000, description: "w".repeat(6000) }),
        ),
      ),
      CADES_FILE_FORMAT.mimeType,
      name,
    );
    const preview = (await readCadesPreview(file, name)).unwrap();
    expect(preview.layers).toHaveLength(1);
    expect(preview.invoice?.invoices[0]?.lineCount).toBe(1000);
    expect(preview.invoice?.invoices[0]?.lines.length).toBeLessThan(1000);
  });

  test("a signed file holding plain text keeps its text and no invoice", async () => {
    const name = "note.txt.p7m";
    const file = storedFile(
      await wrapP7m(xmlBytes("Signed plain note")),
      CADES_FILE_FORMAT.mimeType,
      name,
    );
    const preview = (await readCadesPreview(file, name)).unwrap();
    expect(preview).toMatchObject({ invoice: null, text: "Signed plain note" });
  });
});
