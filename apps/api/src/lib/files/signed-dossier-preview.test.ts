import { PDF, StandardFonts } from "@libpdf/core";
import { expect, test } from "bun:test";

import { FILE_PART_KINDS } from "@stll/api-contract/file-parts";
import {
  E_AKTA_FILE_FORMAT,
  XADES_ZEP_FILE_FORMAT,
  ZEP_FILE_FORMAT,
} from "@stll/api-contract/legal-file-formats";
import { ZipArchive } from "@stll/docx-core/zip";

import { readSignedDossierPreview } from "@/api/lib/files/archive-preview";
import { readPartOfFile } from "@/api/lib/files/file-part";
import { extractFileTextResult } from "@/api/lib/search/extract-content";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import {
  makeEAktaFixture,
  makeXadesZepFixture,
  makeZepEnvelope,
  makeZepFixture,
} from "@/api/tests/fixtures/signed-dossier";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

const marker = "Text of the signed decision";

const pdfBytes = async () => {
  const pdf = PDF.create();
  pdf.addPage({ width: 300, height: 200 }).drawText(marker, {
    x: 20,
    y: 60,
    size: 14,
    font: StandardFonts.Helvetica,
  });
  return await pdf.save();
};

const stored = (bytes: Uint8Array, fileName: string, mimeType: string) =>
  testScannedFile({
    bytes: new Uint8Array(bytes).buffer,
    path: `org/ws/${fileName}`,
    mimeType,
  });

const document = (index: number) => ({
  kind: FILE_PART_KINDS.document,
  index,
});

test("previews an e-akta dossier uploaded under a generic type, and search reads the same text", async () => {
  const pdf = await pdfBytes();
  const nested = new ZipArchive();
  nested.set("draft.txt", "Private draft inside an opaque ZIP");
  const bytes = await makeEAktaFixture({
    documents: [
      {
        title: "kérelem.txt",
        extension: "txt",
        bytes: "Kérelem száma 47",
        transforms: ["zip", "base64"],
      },
      { title: "végzés.pdf", extension: "pdf", bytes: pdf },
      {
        title: "csomag.zip",
        extension: "zip",
        bytes: new Uint8Array(await nested.generate()),
      },
    ],
    frameSigners: ["Example frame signer"],
  });
  const source = stored(bytes, "kérelem.dosszie", "application/octet-stream");
  const preview = (
    await readSignedDossierPreview(source, {
      zipNameCodePage: "ibm437",
      expectedMimeType: E_AKTA_FILE_FORMAT.mimeType,
    })
  ).unwrap();
  expect(preview).toEqual({
    receipt: false,
    signers: [{ id: "signature-0", name: "Example frame signer" }],
    documents: [
      {
        id: "document-0",
        fileName: "kérelem.txt",
        text: "Kérelem száma 47",
        status: "readable",
        textFormat: "plain",
        part: {
          part: "document:0",
          fileName: "kérelem.txt",
          mediaType: "text/plain",
          sizeBytes: new TextEncoder().encode("Kérelem száma 47").byteLength,
        },
      },
      {
        id: "document-1",
        fileName: "végzés.pdf",
        text: expect.stringContaining(marker),
        status: "readable",
        textFormat: "markdown",
        part: {
          part: "document:1",
          fileName: "végzés.pdf",
          mediaType: PDF_MIME_TYPE,
          sizeBytes: pdf.byteLength,
        },
      },
      {
        id: "document-2",
        fileName: "csomag.zip",
        text: "",
        status: "unavailable",
        textFormat: "plain",
        // A document without readable text is still a part of the file.
        part: expect.objectContaining({ part: "document:2" }),
      },
    ],
  });

  const extracted = (
    await extractFileTextResult(source, { zipNameCodePage: "ibm437" })
  ).unwrap();
  expect(extracted).toContain("Signatures are unverified.");
  expect(extracted).toContain("Signer: Example frame signer");
  expect(extracted).toContain("Kérelem száma 47");
  expect(extracted).toContain(marker);
  expect(extracted).toContain("csomag.zip");
  expect(extracted).not.toContain("Private draft inside an opaque ZIP");

  const dossier = source.withMimeType(E_AKTA_FILE_FORMAT.mimeType);
  const delivered = await readPartOfFile(dossier, document(1), "ibm437");
  expect(delivered.unwrap()).toEqual({
    fileName: "végzés.pdf",
    mimeType: PDF_MIME_TYPE,
    bytes: pdf,
  });
  const text = (await readPartOfFile(dossier, document(0), "ibm437")).unwrap();
  expect(new TextDecoder().decode(text.bytes)).toBe("Kérelem száma 47");
  const beyond = await readPartOfFile(dossier, document(3), "ibm437");
  expect(beyond.isErr() && beyond.error.status).toBe(404);
});

test("previews a ZEPf container stored as a generic ZIP", async () => {
  const pdf = await pdfBytes();
  const bytes = await makeZepFixture({
    envelope: makeZepEnvelope({
      body: "Žiadosť",
      attachments: [
        {
          fileName: "rozhodnutie.pdf",
          mimeType: "application/pdf",
          bytes: pdf,
        },
      ],
    }),
  });
  const source = stored(bytes, "podanie.zep", "application/zip");
  const preview = (
    await readSignedDossierPreview(source, {
      zipNameCodePage: "ibm437",
      expectedMimeType: ZEP_FILE_FORMAT.mimeType,
    })
  ).unwrap();
  expect(preview.signers).toEqual([
    { id: "signature-0.signer-0", name: "Example first signer" },
  ]);
  expect(preview.documents).toEqual([
    {
      id: "document-0",
      fileName: "M20260105090000Z.txt",
      text: "Žiadosť",
      status: "readable",
      textFormat: "plain",
      part: expect.objectContaining({
        part: "document:0",
        mediaType: "text/plain",
      }),
    },
    {
      id: "document-1",
      fileName: "rozhodnutie.pdf",
      text: expect.stringContaining(marker),
      status: "readable",
      textFormat: "markdown",
      part: {
        part: "document:1",
        fileName: "rozhodnutie.pdf",
        mediaType: PDF_MIME_TYPE,
        sizeBytes: pdf.byteLength,
      },
    },
  ]);
  const delivered = await readPartOfFile(
    source.withMimeType(ZEP_FILE_FORMAT.mimeType),
    document(1),
    "ibm437",
  );
  expect(delivered.unwrap().bytes).toEqual(pdf);
  expect(
    (
      await extractFileTextResult(source, { zipNameCodePage: "ibm437" })
    ).unwrap(),
  ).toContain("Žiadosť");
});

test("within the indexing budget, keeps later names and marks clipping", async () => {
  const bytes = await makeEAktaFixture({
    documents: [
      {
        title: "long.txt",
        extension: "txt",
        bytes: "Filing text ".repeat(500),
      },
      { title: "short.txt", extension: "txt", bytes: "Reply" },
    ],
  });
  const source = stored(bytes, "record.es3", E_AKTA_FILE_FORMAT.mimeType);
  const maxChars = 300;
  const text = (
    await extractFileTextResult(source, { zipNameCodePage: "ibm437", maxChars })
  ).unwrap();
  expect(text).toContain("Filing text");
  expect(text).toContain("Document: short.txt");
  expect(text?.match(/Document text was truncated\./gu)).toHaveLength(2);
  expect(text?.length).toBeLessThanOrEqual(maxChars);
});

test("refuses preview when an embedded file fails the upload scan", async () => {
  const bytes = await makeEAktaFixture({
    documents: [
      {
        title: "archive.zip",
        extension: "zip",
        bytes: Uint8Array.of(0x50, 0x4b, 0x03, 0x04),
      },
    ],
  });
  const source = stored(bytes, "record.es3", E_AKTA_FILE_FORMAT.mimeType);
  const preview = await readSignedDossierPreview(source, {
    zipNameCodePage: "ibm437",
  });
  expect(preview.isErr() && preview.error.message).toBe(
    "An embedded file did not pass the security scan",
  );
  const unreadable = await readSignedDossierPreview(
    stored(
      new TextEncoder().encode("<note/>"),
      "x.es3",
      E_AKTA_FILE_FORMAT.mimeType,
    ),
    { zipNameCodePage: "ibm437" },
  );
  expect(unreadable.isErr() && unreadable.error.status).toBe(422);
});

test("delivers a zipped PDF that inflates past the size of its container", async () => {
  const pdf = await pdfBytes();
  // Trailing whitespace after the end marker keeps the bytes a valid PDF.
  const padded = new Uint8Array(pdf.byteLength + 2 * 1024 * 1024).fill(0x20);
  padded.set(pdf);
  const bytes = await makeEAktaFixture({
    documents: [
      {
        title: "végzés.pdf",
        extension: "pdf",
        bytes: padded,
        transforms: ["zip", "base64"],
      },
    ],
  });
  expect(bytes.byteLength).toBeLessThan(padded.byteLength);
  const delivered = await readPartOfFile(
    stored(bytes, "record.es3", E_AKTA_FILE_FORMAT.mimeType),
    document(0),
    "ibm437",
  );
  expect(delivered.unwrap().bytes).toEqual(padded);
});

test("previews a XAdES_ZEP envelope stored under a generic type, PDF included", async () => {
  const pdf = await pdfBytes();
  const bytes = await makeXadesZepFixture({
    form: "enveloping",
    objects: [
      {
        id: "Data1",
        description: "Rozhodnutie",
        mimeType: "application/pdf",
        content: pdf,
      },
      {
        id: "Data2",
        description: "Podanie",
        mimeType: "application/xml",
        content: {
          xml: "<podanie><vec>Návrh na začatie konania</vec></podanie>",
        },
      },
    ],
  });
  const source = stored(bytes, "podanie.xzep", "application/xml");
  const preview = (
    await readSignedDossierPreview(source, {
      zipNameCodePage: "ibm437",
      expectedMimeType: XADES_ZEP_FILE_FORMAT.mimeType,
    })
  ).unwrap();
  expect(preview.signers.map(({ name }) => name)).toEqual([
    "Example envelope signer",
  ]);
  expect(preview.documents).toMatchObject([
    {
      fileName: "Rozhodnutie.pdf",
      part: { part: "document:0", mediaType: PDF_MIME_TYPE },
      status: "readable",
    },
    {
      fileName: "Podanie.xml",
      part: { part: "document:1", fileName: "Podanie.xml" },
      text: "Návrh na začatie konania",
      textFormat: "plain",
    },
  ]);
  const envelope = source.withMimeType(XADES_ZEP_FILE_FORMAT.mimeType);
  const delivered = await readPartOfFile(envelope, document(0), "ibm437");
  expect(delivered.unwrap().bytes).toEqual(pdf);
  // A document of any type opens, not only a PDF.
  const xml = (await readPartOfFile(envelope, document(1), "ibm437")).unwrap();
  expect(new TextDecoder().decode(xml.bytes)).toContain(
    "Návrh na začatie konania",
  );
  const extracted = (
    await extractFileTextResult(source, { zipNameCodePage: "ibm437" })
  ).unwrap();
  expect(extracted).toContain("Návrh na začatie konania");
  expect(extracted).toContain(marker);
});

test("says in search text that an e-akta receipt is a delivery receipt", async () => {
  const bytes = await makeEAktaFixture({
    category: "electronic acknowledgement",
    documents: [
      { title: "elismervény.txt", extension: "txt", bytes: "Átvéve" },
    ],
  });
  const source = stored(bytes, "elismervény.et3", "application/octet-stream");
  const preview = (
    await readSignedDossierPreview(source, {
      zipNameCodePage: "ibm437",
      expectedMimeType: E_AKTA_FILE_FORMAT.mimeType,
    })
  ).unwrap();
  expect(preview.receipt).toBe(true);
  const extracted = (
    await extractFileTextResult(source, { zipNameCodePage: "ibm437" })
  ).unwrap();
  expect(extracted?.startsWith("Signed delivery receipt.")).toBe(true);
});
