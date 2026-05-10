import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { extractBinary, extractText, loadDocx, repackZip } from "./zip";

describe("DOCX ZIP helpers", () => {
  test("roundtrips text and binary parts through standard DOCX repacking", async () => {
    const zip = new JSZip();
    const binary = new Uint8Array([0, 1, 2, 253, 254, 255]);

    zip.file("word/document.xml", "<w:document>Hello</w:document>");
    zip.file("word/media/image.bin", binary);

    const buffer = await repackZip(zip);
    const loaded = await loadDocx(buffer);

    expect(await extractText(loaded, "word/document.xml")).toBe(
      "<w:document>Hello</w:document>",
    );

    const extracted = await extractBinary(loaded, "word/media/image.bin");
    expect(extracted).not.toBeNull();
    expect(new Uint8Array(extracted ?? new ArrayBuffer(0))).toEqual(binary);
  });

  test("returns null for missing text and binary parts", async () => {
    const loaded = await loadDocx(await repackZip(new JSZip()));

    expect(await extractText(loaded, "word/missing.xml")).toBeNull();
    expect(await extractBinary(loaded, "word/missing.bin")).toBeNull();
  });
});
