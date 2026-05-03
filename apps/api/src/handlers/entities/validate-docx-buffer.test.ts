import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

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
      error: "Missing word/document.xml",
    });
  });

  test("rejects malformed main document XML", async () => {
    const documentXml = `<w:document xmlns:w="${W_NS}"><w:body><w:p></w:document>`;

    const result = await validateDocxBuffer(await makeDocxBuffer(documentXml));

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Malformed document.xml");
    }
  });
});
