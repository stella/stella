import { PDF, StandardFonts } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import { CADES_FILE_FORMAT } from "@stll/api-contract/legal-file-formats";

import { readCadesPdf, readCadesPreview } from "@/api/lib/files/cades-preview";
import { extractFileTextResult } from "@/api/lib/search/extract-content";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { wrapP7m } from "@/api/tests/fixtures/p7m";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

const signedFile = (bytes: Uint8Array, fileName: string) =>
  testScannedFile({
    bytes: new Uint8Array(bytes).buffer,
    mimeType: CADES_FILE_FORMAT.mimeType,
    path: `org/ws/${fileName}`,
  });

describe("CAdES file reading", () => {
  test("extracts the deepest PDF and leaves its bytes unchanged", async () => {
    const pdf = PDF.create();
    pdf.addPage({ width: 300, height: 200 }).drawText("Signed filing text", {
      x: 20,
      y: 60,
      size: 14,
      font: StandardFonts.Helvetica,
    });
    const bytes = await pdf.save();
    const name = "filing.pdf.p7m.p7m";
    const signed = signedFile(
      await wrapP7m(await wrapP7m(bytes), { signers: ["issuer", "ski"] }),
      name,
    );

    const result = await readCadesPdf(signed, name);
    expect(result.unwrap()).toEqual(bytes);

    const preview = (await readCadesPreview(signed, name)).unwrap();
    expect(preview).toMatchObject({
      fileName: "filing.pdf",
      mimeType: PDF_MIME_TYPE,
      text: expect.stringContaining("Signed filing text"),
    });
    expect(
      preview.layers.map(({ signers }) =>
        signers.map((signer) => signer.name).toSorted(),
      ),
    ).toEqual([
      ["Example first signer", "Example second signer"],
      ["Example first signer"],
    ]);
  });

  test("extracts UTF-8 payloads for preview and search without trusting a PDF filename", async () => {
    const text = "Signed correspondence č. 47";
    const name = "notice.pdf.p7m";
    const signed = signedFile(
      await wrapP7m(new TextEncoder().encode(text)),
      name,
    );

    const preview = await readCadesPreview(signed, name);
    expect(preview.unwrap()).toMatchObject({
      mimeType: "text/plain",
      text,
    });
    const pdf = await readCadesPdf(signed, name);
    expect(pdf.isErr() && pdf.error.status).toBe(422);

    const extraction = await extractFileTextResult(signed);
    expect(extraction.unwrap()).toContain(text);
    expect(extraction.unwrap()).toContain("Signatures are unverified.");
  });

  test("retains signer metadata when the payload has no readable text", async () => {
    const name = "unknown.bin.p7m";
    const signed = signedFile(
      await wrapP7m(Uint8Array.of(0xf5, 0xfe, 0xff)),
      name,
    );
    const preview = await readCadesPreview(signed, name);

    expect(preview.unwrap()).toMatchObject({
      fileName: "unknown.bin",
      mimeType: "application/octet-stream",
      text: "",
      layers: [{ signers: [{ name: "Example first signer" }] }],
    });
  });

  test("refuses a signed payload rejected by the file scanner", async () => {
    const malformedZip = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
    const name = "archive.zip.p7m";
    const signed = signedFile(
      await wrapP7m(malformedZip, { constructed: true }),
      name,
    );
    const result = await readCadesPreview(signed, name);
    expect(result.isErr() && result.error.message).toBe(
      "The embedded file did not pass the security scan",
    );

    const extraction = await extractFileTextResult(signed);
    expect(extraction.isErr() && extraction.error.workerErrorClass).toBe(
      "FileScanRejectedError",
    );
  });
});
