import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { DOCX_MAX_ENTRIES } from "@/api/lib/docx-archive";

import { validateDocxBuffer } from "./validate-docx-buffer";

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const makeDocxBuffer = async (documentXml?: string) => {
  const zip = new JSZip();

  if (documentXml !== undefined) {
    zip.file("word/document.xml", documentXml);
  }

  return await zip.generateAsync({ type: "arraybuffer" });
};

describe("DOCX buffer validation", () => {
  test("accepts valid document XML with self-closing paragraphs", async () => {
    const documentXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="${W_NS}">` +
      `<w:body><w:p/><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body>` +
      `</w:document>`;

    const result = await validateDocxBuffer(await makeDocxBuffer(documentXml));

    expect(result).toEqual({ valid: true });
  });

  test("rejects archives without a main document part", async () => {
    const result = await validateDocxBuffer(await makeDocxBuffer());

    expect(result).toEqual({
      valid: false,
      reason: "missing-document-xml",
      error: "Missing word/document.xml",
    });
  });

  test("rejects malformed main document XML", async () => {
    const documentXml = `<w:document xmlns:w="${W_NS}"><w:body><w:p></w:document>`;

    const result = await validateDocxBuffer(await makeDocxBuffer(documentXml));

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("malformed-document-xml");
      expect(result.error).toContain("Malformed document.xml");
    }
  });

  test("reports bytes that are not a readable archive as unreadable, unprefixed", async () => {
    const truncated = (await makeDocxBuffer(`<w:document xmlns:w="${W_NS}"/>`))
      // A payload the model retyped or truncated still starts with the ZIP
      // magic but no longer carries a readable central directory.
      .slice(0, 24);

    const result = await validateDocxBuffer(truncated);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe("unreadable-archive");
      // Callers embed `error` in their own sentence, so it must not repeat a
      // prefix of its own.
      expect(result.error).not.toContain("Invalid DOCX");
    }
  });

  test("separates an archive that breaks a decompression bound from one that will not open", async () => {
    const zip = new JSZip();
    zip.file("word/document.xml", `<w:document xmlns:w="${W_NS}"/>`);
    for (let index = 0; index < DOCX_MAX_ENTRIES; index += 1) {
      zip.file(`word/media/${String(index)}.bin`, "x");
    }
    const overBound = await zip.generateAsync({ type: "arraybuffer" });

    const result = await validateDocxBuffer(overBound);

    expect(result.valid).toBe(false);
    if (!result.valid) {
      // These bytes arrived intact, so telling the caller to re-encode them
      // would send it after a fault that is not there.
      expect(result.reason).toBe("archive-limit-exceeded");
    }
  });
});
