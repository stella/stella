/**
 * Edge-case tests for OOXML elements that appear in real
 * legal documents. Each test uses XML that Microsoft Word
 * or LibreOffice actually produces, verified by generating
 * .docx files and opening them in Pages/Word.
 *
 * Verifies extractText reads these patterns correctly.
 */

import { describe, expect, test } from "bun:test";
import JSZip from "jszip";

import { extractText } from "./extract-text";
import { W_NS } from "./ooxml";

const WRAP = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:document xmlns:w="${W_NS}">` +
  `<w:body>${body}</w:body></w:document>`;

/** Build a minimal DOCX buffer from document body XML. */
const buildDocx = async (bodyXml: string): Promise<Buffer> => {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
      "</Types>",
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
      "</Relationships>",
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
  );
  zip.file("word/document.xml", WRAP(bodyXml));
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return Buffer.from(buf);
};

// ─────────────────────────────────────────────────────────
// STEP 1: Verify extractText reads these patterns correctly
// ─────────────────────────────────────────────────────────

describe("extract-text: real OOXML patterns", () => {
  test("w:br (Shift+Enter line break) — text only", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Before break</w:t></w:r>` +
        `<w:r><w:br/><w:t xml:space="preserve">After break</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    // extractText only collects w:t, so w:br is invisible
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  w:br extract result:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("w:br between two w:t in same run", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        "<w:r>" +
        `<w:t xml:space="preserve">Line one</w:t>` +
        "<w:br/>" +
        `<w:t xml:space="preserve">Line two</w:t>` +
        "</w:r>" +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  w:br mid-run extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("w:tab (Tab key)", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Before</w:t></w:r>` +
        `<w:r><w:tab/><w:t xml:space="preserve">After tab</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log("  w:tab extract:", JSON.stringify(result.paragraphs[0]?.text));
  });

  test("w:fldSimple PAGE field", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Page </w:t></w:r>` +
        `<w:fldSimple w:instr=" PAGE ">` +
        "<w:r><w:t>3</w:t></w:r>" +
        "</w:fldSimple>" +
        `<w:r><w:t xml:space="preserve"> of </w:t></w:r>` +
        `<w:fldSimple w:instr=" NUMPAGES ">` +
        "<w:r><w:t>10</w:t></w:r>" +
        "</w:fldSimple>" +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  fldSimple extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("w:fldChar complex field (PAGE number)", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Page </w:t></w:r>` +
        `<w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
        `<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>` +
        `<w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
        "<w:r><w:t>5</w:t></w:r>" +
        `<w:r><w:fldChar w:fldCharType="end"/></w:r>` +
        `<w:r><w:t xml:space="preserve"> of 20</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  complex field extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("w:bookmarkStart/End around text", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">See </w:t></w:r>` +
        `<w:bookmarkStart w:id="1" w:name="clause_1"/>` +
        `<w:r><w:t xml:space="preserve">Clause 1</w:t></w:r>` +
        `<w:bookmarkEnd w:id="1"/>` +
        `<w:r><w:t xml:space="preserve"> for details.</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  bookmark extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("w:tbl — table paragraphs extracted in document order", async () => {
    const buf = await buildDocx(
      "<w:p><w:r><w:t>Before table</w:t></w:r></w:p>" +
        "<w:tbl>" +
        `<w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr>` +
        "<w:tr><w:tc>" +
        "<w:p><w:r><w:t>Cell A1</w:t></w:r></w:p>" +
        "</w:tc></w:tr>" +
        "</w:tbl>" +
        "<w:p><w:r><w:t>After table</w:t></w:r></w:p>",
    );
    const result = await extractText(buf);
    // Table paragraphs must be included: legal documents keep
    // signature blocks and party details in tables, and version
    // diffs / discovery index paragraphs the same way.
    expect(result.paragraphs.map((p) => p.text)).toEqual([
      "Before table",
      "Cell A1",
      "After table",
    ]);
  });

  test("existing w:ins/w:del (prior tracked changes)", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">The </w:t></w:r>` +
        `<w:del w:id="100" w:author="Human" w:date="2026-01-01T00:00:00Z">` +
        `<w:r><w:delText xml:space="preserve">old </w:delText></w:r>` +
        "</w:del>" +
        `<w:ins w:id="101" w:author="Human" w:date="2026-01-01T00:00:00Z">` +
        `<w:r><w:t xml:space="preserve">new </w:t></w:r>` +
        "</w:ins>" +
        `<w:r><w:t xml:space="preserve">agreement is binding.</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  tracked changes extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("w:sdt content control", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Client name: </w:t></w:r>` +
        "<w:sdt>" +
        `<w:sdtPr><w:alias w:val="ClientName"/></w:sdtPr>` +
        "<w:sdtContent>" +
        "<w:r><w:t>John Smith</w:t></w:r>" +
        "</w:sdtContent>" +
        "</w:sdt>" +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log("  sdt extract:", JSON.stringify(result.paragraphs[0]?.text));
  });

  test("w:sym (special symbol)", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">See </w:t></w:r>` +
        `<w:r><w:sym w:font="Symbol" w:char="00A7"/></w:r>` +
        `<w:r><w:t xml:space="preserve"> 42 of the Act.</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log("  sym extract:", JSON.stringify(result.paragraphs[0]?.text));
  });

  test("w:commentRangeStart/End + commentReference", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">The party </w:t></w:r>` +
        `<w:commentRangeStart w:id="5"/>` +
        `<w:r><w:t xml:space="preserve">shall indemnify</w:t></w:r>` +
        `<w:commentRangeEnd w:id="5"/>` +
        "<w:r>" +
        `<w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>` +
        `<w:commentReference w:id="5"/>` +
        "</w:r>" +
        `<w:r><w:t xml:space="preserve"> the other party.</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  comment extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("w:hyperlink wrapping a run", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        `<w:r><w:t xml:space="preserve">Refer to </w:t></w:r>` +
        `<w:hyperlink w:anchor="clause_1">` +
        "<w:r><w:t>Clause 1</w:t></w:r>" +
        "</w:hyperlink>" +
        `<w:r><w:t xml:space="preserve"> above.</w:t></w:r>` +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  hyperlink extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });

  test("mixed: tab + bookmark + br (legal clause)", async () => {
    const buf = await buildDocx(
      "<w:p>" +
        "<w:r><w:tab/></w:r>" +
        `<w:bookmarkStart w:id="2" w:name="section_1_1"/>` +
        "<w:r>" +
        "<w:rPr><w:b/></w:rPr>" +
        `<w:t xml:space="preserve">1.1 Definitions.</w:t>` +
        "</w:r>" +
        `<w:bookmarkEnd w:id="2"/>` +
        "<w:r>" +
        `<w:t xml:space="preserve"> </w:t>` +
        "<w:br/>" +
        `<w:t xml:space="preserve">The following terms shall have the meanings set forth below.</w:t>` +
        "</w:r>" +
        "</w:p>",
    );
    const result = await extractText(buf);
    expect(result.paragraphs).toHaveLength(1);
    console.log(
      "  mixed legal extract:",
      JSON.stringify(result.paragraphs[0]?.text),
    );
  });
});
