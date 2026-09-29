import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { testDocxFile } from "@/api/tests/helpers/scanned-file";

import { renderTemplatePreview } from "./render-template-preview";

const makeDocx = async (body: string): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  zip.file(
    "[Content_Types].xml",
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
  );
  return zip.generateAsync({ type: "nodebuffer" });
};

const paragraph = (text: string) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

describe("renderTemplatePreview", () => {
  test("renders preview details from a scanned DOCX file", async () => {
    const docxBytes = await makeDocx(
      [
        paragraph("Intro"),
        paragraph("Buyer {% if has_spouse %} and spouse"),
        paragraph('{{ clause("Confidentiality") }}'),
      ].join(""),
    );

    const preview = await renderTemplatePreview(testDocxFile(docxBytes));

    expect(preview.paragraphs.map(({ text }) => text)).toEqual([
      "Intro",
      "Buyer {% if has_spouse %} and spouse",
      '{{ clause("Confidentiality") }}',
    ]);
    expect(preview.charCount).toBe(
      'IntroBuyer {% if has_spouse %} and spouse{{ clause("Confidentiality") }}'
        .length,
    );
    expect(preview.structureErrors).toEqual([
      expect.objectContaining({
        paragraphIndex: 1,
        source: "body",
      }),
    ]);
    expect(preview.clauseSlots).toEqual(["Confidentiality"]);
  });
});
