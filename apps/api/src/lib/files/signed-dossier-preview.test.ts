import { PDF, StandardFonts } from "@libpdf/core";
import { expect, test } from "bun:test";

import {
  E_AKTA_FILE_FORMAT,
  XADES_ZEP_FILE_FORMAT,
  ZEP_FILE_FORMAT,
} from "@stll/api-contract/legal-file-formats";
import { ZipArchive } from "@stll/docx-core/zip";

import {
  readSignedDossierPdf,
  readSignedDossierPreview,
} from "@/api/lib/files/archive-preview";
import { extractFileTextResult } from "@/api/lib/search/extract-content";
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
    await readSignedDossierPreview(source, E_AKTA_FILE_FORMAT.mimeType)
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
        pdf: false,
      },
      {
        id: "document-1",
        fileName: "végzés.pdf",
        text: expect.stringContaining(marker),
        status: "readable",
        textFormat: "markdown",
        pdf: true,
      },
      {
        id: "document-2",
        fileName: "csomag.zip",
        text: "",
        status: "unavailable",
        textFormat: "plain",
        pdf: false,
      },
    ],
  });

  const extracted = (await extractFileTextResult(source)).unwrap();
  expect(extracted).toContain("Signatures are unverified.");
  expect(extracted).toContain("Signer: Example frame signer");
  expect(extracted).toContain("Kérelem száma 47");
  expect(extracted).toContain(marker);
  expect(extracted).toContain("csomag.zip");
  expect(extracted).not.toContain("Private draft inside an opaque ZIP");

  const delivered = await readSignedDossierPdf(
    source.withMimeType(E_AKTA_FILE_FORMAT.mimeType),
    1,
  );
  expect(delivered.unwrap()).toEqual(pdf);
  for (const position of [0, 2, 3]) {
    const refused = await readSignedDossierPdf(
      source.withMimeType(E_AKTA_FILE_FORMAT.mimeType),
      position,
    );
    expect(refused.isErr() && refused.error.status).toBe(422);
  }
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
    await readSignedDossierPreview(source, ZEP_FILE_FORMAT.mimeType)
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
      pdf: false,
    },
    {
      id: "document-1",
      fileName: "rozhodnutie.pdf",
      text: expect.stringContaining(marker),
      status: "readable",
      textFormat: "markdown",
      pdf: true,
    },
  ]);
  const delivered = await readSignedDossierPdf(
    source.withMimeType(ZEP_FILE_FORMAT.mimeType),
    1,
  );
  expect(delivered.unwrap()).toEqual(pdf);
  expect((await extractFileTextResult(source)).unwrap()).toContain("Žiadosť");
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
  const text = (await extractFileTextResult(source, { maxChars })).unwrap();
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
  const preview = await readSignedDossierPreview(source);
  expect(preview.isErr() && preview.error.message).toBe(
    "An embedded file did not pass the security scan",
  );
  const unreadable = await readSignedDossierPreview(
    stored(
      new TextEncoder().encode("<note/>"),
      "x.es3",
      E_AKTA_FILE_FORMAT.mimeType,
    ),
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
  const delivered = await readSignedDossierPdf(
    stored(bytes, "record.es3", E_AKTA_FILE_FORMAT.mimeType),
    0,
  );
  expect(delivered.unwrap()).toEqual(padded);
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
    await readSignedDossierPreview(source, XADES_ZEP_FILE_FORMAT.mimeType)
  ).unwrap();
  expect(preview.signers.map(({ name }) => name)).toEqual([
    "Example envelope signer",
  ]);
  expect(preview.documents).toMatchObject([
    { fileName: "Rozhodnutie.pdf", pdf: true, status: "readable" },
    {
      fileName: "Podanie.xml",
      pdf: false,
      text: "Návrh na začatie konania",
      textFormat: "plain",
    },
  ]);
  const delivered = await readSignedDossierPdf(
    source.withMimeType(XADES_ZEP_FILE_FORMAT.mimeType),
    0,
  );
  expect(delivered.unwrap()).toEqual(pdf);
  const extracted = (await extractFileTextResult(source)).unwrap();
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
    await readSignedDossierPreview(source, E_AKTA_FILE_FORMAT.mimeType)
  ).unwrap();
  expect(preview.receipt).toBe(true);
  const extracted = (await extractFileTextResult(source)).unwrap();
  expect(extracted?.startsWith("Signed delivery receipt.")).toBe(true);
});
