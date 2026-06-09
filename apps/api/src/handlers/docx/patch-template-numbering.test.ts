import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { fillTemplate } from "./patch-template";

const buildDocxBuffer = async (paragraphs: string[]): Promise<Buffer> => {
  const para = (text: string) =>
    `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(para).join("")}<w:sectPr/></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypes);
  zip.file("_rels/.rels", rels);
  zip.file("word/document.xml", documentXml);
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
};

// Concatenated visible text: value substitution splits a paragraph into
// multiple <w:t> runs, so assert on the stripped text, not the raw XML.
const docTextOf = async (buffer: Buffer): Promise<string> => {
  const zip = await JSZip.loadAsync(buffer);
  let text = (await zip.file("word/document.xml")?.async("string")) ?? "";
  // Strip tags until stable so a tag span revealed by an earlier removal can't
  // survive — the single-pass form trips CodeQL's incomplete-sanitization check.
  let previous = "";
  while (text !== previous) {
    previous = text;
    // oxlint-disable-next-line sonarjs/slow-regex -- test helper on small, controlled document XML
    text = text.replace(/<[^>]+>/gu, "");
  }
  return text;
};

const lease = [
  "Clause {{@num:rent}}. Rent is {{rent}}.",
  "{{#if has_guarantee}}",
  "Clause {{@num:guarantee}}. Guarantee provided.",
  "{{/if}}",
  "See Clause {{@ref:rent}}. Per Clause {{@ref:guarantee}}.",
];

describe("fillTemplate — cross-reference numbering", () => {
  test("numbers included clauses and resolves references to them", async () => {
    const docx = await buildDocxBuffer(lease);
    const { buffer } = await fillTemplate(docx, {
      rent: "5000",
      has_guarantee: true,
    });
    const text = await docTextOf(buffer);

    expect(text).toContain("Clause 1. Rent is 5000.");
    expect(text).toContain("Clause 2. Guarantee provided.");
    // forward + backward refs resolve to the assigned numbers
    expect(text).toContain("See Clause 1. Per Clause 2.");
  });

  test("a clause excluded by a condition is not numbered; its ref stays unresolved", async () => {
    const docx = await buildDocxBuffer(lease);
    const { buffer } = await fillTemplate(docx, {
      rent: "5000",
      has_guarantee: false,
    });
    const text = await docTextOf(buffer);

    expect(text).toContain("Clause 1. Rent is 5000.");
    expect(text).not.toContain("Guarantee provided.");
    // rent is still clause 1; the dropped guarantee reference is left visible
    expect(text).toContain("See Clause 1.");
    expect(text).toContain("{{@ref:guarantee}}");
  });
});
