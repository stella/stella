import { PDF, StandardFonts } from "@libpdf/core";
import { describe, expect, test } from "bun:test";

import { FILE_PART_KINDS } from "@stll/api-contract/file-parts";
import { CADES_FILE_FORMAT } from "@stll/api-contract/legal-file-formats";
import { compareCodeUnit } from "@stll/collation";

import { readCadesPreview } from "@/api/lib/files/cades-preview";
import { readPartOfFile } from "@/api/lib/files/file-part";
import { extractFileTextResult } from "@/api/lib/search/extract-content";
import { PDF_MIME_TYPE } from "@/api/mime-types";
import { wrapP7m } from "@/api/tests/fixtures/p7m";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

const signedFile = (bytes: Uint8Array, fileName: string) =>
  testScannedFile({
    bytes: new Uint8Array(bytes).buffer,
    mimeType: CADES_FILE_FORMAT.mimeType,
    path: fileName,
  });

const SIGNED_CONTENT = { kind: FILE_PART_KINDS.content, index: 0 } as const;

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
      await wrapP7m(await wrapP7m(bytes), { signers: ["issuer", "issuer"] }),
      name,
    );

    const content = (
      await readPartOfFile(signed, SIGNED_CONTENT, "ibm437")
    ).unwrap();
    expect(content).toEqual({
      fileName: "filing.pdf",
      mimeType: PDF_MIME_TYPE,
      bytes,
    });

    const preview = (
      await readCadesPreview(signed, {
        zipNameCodePage: "ibm437",
        fileName: name,
      })
    ).unwrap();
    expect(preview).toMatchObject({
      fileName: "filing.pdf",
      mimeType: PDF_MIME_TYPE,
      text: expect.stringContaining("Signed filing text"),
      textFormat: "markdown",
    });
    expect(
      preview.layers.map(({ signers }) =>
        signers
          .map((signer) => signer.name)
          .toSorted((left, right) => compareCodeUnit(left ?? "", right ?? "")),
      ),
    ).toEqual([
      ["Example first signer", "Example second signer"],
      ["Example first signer"],
    ]);
    expect(
      preview.layers.map(({ id, signers }) => [id, signers.map((s) => s.id)]),
    ).toEqual([
      ["layer-0", ["layer-0.signer-0", "layer-0.signer-1"]],
      ["layer-0.1", ["layer-0.1.signer-0"]],
    ]);
  });

  test("extracts UTF-8 payloads for preview and search without trusting a PDF filename", async () => {
    const text = "Signed correspondence č. 47";
    const name = "notice.pdf.p7m";
    const signed = signedFile(
      await wrapP7m(new TextEncoder().encode(text)),
      name,
    );

    const preview = await readCadesPreview(signed, {
      zipNameCodePage: "ibm437",
      fileName: name,
    });
    expect(preview.unwrap()).toMatchObject({
      mimeType: "text/plain",
      text,
      textFormat: "plain",
    });
    // The signed document opens as what its bytes are, whatever its name says.
    const content = (
      await readPartOfFile(signed, SIGNED_CONTENT, "ibm437")
    ).unwrap();
    expect(content).toMatchObject({
      fileName: "notice.pdf.txt",
      mimeType: "text/plain",
    });
    expect(new TextDecoder().decode(content.bytes)).toBe(text);
    const beyond = await readPartOfFile(
      signed,
      {
        ...SIGNED_CONTENT,
        index: 1,
      },
      "ibm437",
    );
    expect(beyond.isErr() && beyond.error.status).toBe(404);

    const extraction = await extractFileTextResult(signed, {
      zipNameCodePage: "ibm437",
    });
    expect(extraction.unwrap()).toContain(text);
    expect(extraction.unwrap()).toContain("Signatures are unverified.");
  });

  test("retains signer metadata when the payload has no readable text", async () => {
    const name = "unknown.bin.p7m";
    const signed = signedFile(
      await wrapP7m(Uint8Array.of(0xf5, 0xfe, 0xff)),
      name,
    );
    const preview = await readCadesPreview(signed, {
      zipNameCodePage: "ibm437",
      fileName: name,
    });

    expect(preview.unwrap()).toMatchObject({
      fileName: "unknown.bin",
      mimeType: "application/octet-stream",
      text: "",
      textFormat: "plain",
      layers: [
        {
          id: "layer-0",
          signers: [{ id: "layer-0.signer-0", name: "Example first signer" }],
        },
      ],
    });
  });

  test("refuses a signed payload rejected by the file scanner", async () => {
    const malformedZip = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
    const name = "archive.zip.p7m";
    const signed = signedFile(
      await wrapP7m(malformedZip, { constructed: true }),
      name,
    );
    const result = await readCadesPreview(signed, {
      zipNameCodePage: "ibm437",
      fileName: name,
    });
    expect(result.isErr() && result.error.message).toBe(
      "The embedded file did not pass the security scan",
    );

    const extraction = await extractFileTextResult(signed, {
      zipNameCodePage: "ibm437",
    });
    expect(extraction.isErr() && extraction.error.workerErrorClass).toBe(
      "FileScanRejectedError",
    );
  });
});
