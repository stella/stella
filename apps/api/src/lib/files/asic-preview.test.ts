import { PDF, StandardFonts } from "@libpdf/core";
import { expect, test } from "bun:test";

import {
  ASIC_E_FILE_FORMAT,
  ASIC_S_FILE_FORMAT,
} from "@stll/api-contract/legal-file-formats";
import { ZipArchive } from "@stll/docx-core/zip";

import { readAsicPreview } from "@/api/lib/files/archive-preview";
import { extractFileTextResult } from "@/api/lib/search/extract-content";
import { makeAsicFixture } from "@/api/tests/fixtures/asic";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

const storedAsic = (bytes: Uint8Array, fileName: string, mimeType: string) =>
  testScannedFile({
    bytes: new Uint8Array(bytes).buffer,
    path: `org/ws/${fileName}`,
    mimeType,
  });

test("reads ASiC-E payloads for preview and search from a legacy generic upload", async () => {
  const marker = "Text of the signed filing";
  const nested = new ZipArchive();
  nested.set("draft.txt", "Private draft inside an opaque ZIP");
  const pdf = PDF.create();
  pdf.addPage({ width: 300, height: 200 }).drawText(marker, {
    x: 20,
    y: 60,
    size: 14,
    font: StandardFonts.Helvetica,
  });
  const bytes = await makeAsicFixture({
    members: [
      { fileName: "filing.txt", bytes: "Sdělení č. 47" },
      { fileName: "filing.pdf", bytes: await pdf.save() },
      {
        fileName: "archive.docx",
        bytes: new Uint8Array(await nested.generate()),
      },
    ],
  });
  const source = storedAsic(bytes, "filing.asice", "application/octet-stream");
  const preview = await readAsicPreview(source, ASIC_E_FILE_FORMAT.mimeType);
  expect(preview.unwrap().members).toMatchObject([
    {
      fileName: "filing.txt",
      text: "Sdělení č. 47",
      textFormat: "plain",
      status: "readable",
    },
    {
      fileName: "filing.pdf",
      text: expect.stringContaining(marker),
      textFormat: "markdown",
      status: "readable",
    },
    {
      fileName: "archive.docx",
      text: "",
      textFormat: "plain",
      status: "unavailable",
    },
  ]);

  const extracted = (await extractFileTextResult(source)).unwrap();
  expect(extracted).toContain("Signatures are unverified.");
  expect(extracted).toContain("Sdělení č. 47");
  expect(extracted).toContain(marker);
  expect(extracted).toContain("archive.docx");
  expect(extracted).not.toContain("Private draft inside an opaque ZIP");
});

test("reads a recognized Office payload from ASiC-S", async () => {
  const fixtureUrl = new URL(
    "fixtures/folio-core-0.58.5/saved.docx",
    import.meta.url,
  );
  const office = new Uint8Array(await Bun.file(fixtureUrl).arrayBuffer());
  const bytes = await makeAsicFixture({
    mimeType: ASIC_S_FILE_FORMAT.mimeType,
    signature: "cades",
    members: [{ fileName: "agreement.bin", bytes: office }],
  });
  const source = storedAsic(bytes, "filing.asics", ASIC_S_FILE_FORMAT.mimeType);
  const preview = (await readAsicPreview(source)).unwrap();
  expect(preview.members).toEqual([
    {
      fileName: "agreement.bin",
      text: expect.stringContaining("Saved contract. Článek první."),
      textFormat: "markdown",
      status: "readable",
    },
  ]);
});

test("refuses preview and indexing when the member scan rejects unreadable ZIP bytes", async () => {
  const unreadableZip = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
  const bytes = await makeAsicFixture({
    members: [{ fileName: "archive.zip", bytes: unreadableZip }],
  });
  const source = storedAsic(bytes, "filing.asice", ASIC_E_FILE_FORMAT.mimeType);

  const malformed = await readAsicPreview(source, ASIC_S_FILE_FORMAT.mimeType);
  expect(malformed.isErr() && malformed.error.status).toBe(422);

  const preview = await readAsicPreview(source);
  expect(preview.isErr() && preview.error.message).toBe(
    "An embedded file did not pass the security scan",
  );

  const extraction = await extractFileTextResult(source);
  expect(extraction.isErr() && extraction.error.workerErrorClass).toBe(
    "FileScanRejectedError",
  );
});

test("within the indexing text budget, retains later filenames and marks clipping", async () => {
  const bytes = await makeAsicFixture({
    members: [
      { fileName: "long.txt", bytes: "Filing text ".repeat(500) },
      { fileName: "short.txt", bytes: "Reply" },
    ],
  });
  const source = storedAsic(bytes, "filing.asice", ASIC_E_FILE_FORMAT.mimeType);
  const maxChars = 300;
  const text = (await extractFileTextResult(source, { maxChars })).unwrap();
  expect(text).toContain("Filing text");
  expect(text).toContain("Attachment: short.txt");
  expect(text?.match(/Attachment text was truncated\./gu)).toHaveLength(2);
  expect(text?.length).toBeLessThanOrEqual(maxChars);
});
