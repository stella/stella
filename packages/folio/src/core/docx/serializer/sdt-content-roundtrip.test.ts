import { describe, expect, test } from "bun:test";

import { parseParagraph } from "../paragraphParser";
import { parseXmlDocument } from "../xmlParser";
import type { Document, InlineSdt, Paragraph } from "../../types/document";
import { toProseDoc } from "../../prosemirror/conversion/toProseDoc";
import { fromProseDoc } from "../../prosemirror/conversion/fromProseDoc";
import { serializeParagraph } from "./paragraphSerializer";

function parseParagraphXml(xml: string): Paragraph {
  const root = parseXmlDocument(xml);
  if (!root) {
    throw new Error("Failed to parse paragraph XML fixture");
  }
  return parseParagraph(root, null, null, null, null, null);
}

function getInlineSdt(xml: string): InlineSdt {
  const paragraph = parseParagraphXml(xml);
  const sdt = paragraph.content[0];
  if (sdt?.type !== "inlineSdt") {
    throw new Error("Expected first paragraph content to be inlineSdt");
  }
  return sdt;
}

/**
 * Round-trip tests for the inline SDT save path. Mirrors the parser
 * preservation tests in `paragraphParser.test.ts`: these check that the
 * serializer keeps fields, nested SDTs, and math equations inside SDT
 * content instead of silently dropping them on save.
 *
 * Ported from upstream eigenpal/docx-editor PR #486 (commit 491ec9a5a).
 */
describe("inline SDT serialization round-trip", () => {
  test("preserves a simple field inside SDT content through parse → serialize", () => {
    const xml = `
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:sdt>
          <w:sdtPr><w:alias w:val="title-control"/></w:sdtPr>
          <w:sdtContent>
            <w:fldSimple w:instr="TITLE">
              <w:r><w:t>Cached title</w:t></w:r>
            </w:fldSimple>
          </w:sdtContent>
        </w:sdt>
      </w:p>
    `;

    const sdt = getInlineSdt(xml);
    expect(sdt.content[0].type).toBe("simpleField");

    // Field lives inside the surviving SDT wrapper. folio's serializer
    // emits simple fields in their complex-form fldChar equivalent for
    // broader Word/Pages/Docs compatibility, so assert on the field
    // instruction and result text rather than the literal element name.
    const serialized = serializeParagraph(parseParagraphXml(xml));
    expect(serialized).toContain("<w:sdt>");
    expect(serialized).toContain("TITLE");
    expect(serialized).toContain("Cached title");
    expect(serialized).toContain("<w:fldChar");
  });

  test("preserves a complex field inside SDT content through parse → serialize", () => {
    const xml = `
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:sdt>
          <w:sdtPr><w:alias w:val="page-ref"/></w:sdtPr>
          <w:sdtContent>
            <w:r><w:fldChar w:fldCharType="begin"/></w:r>
            <w:r><w:instrText> PAGE </w:instrText></w:r>
            <w:r><w:fldChar w:fldCharType="separate"/></w:r>
            <w:r><w:t>3</w:t></w:r>
            <w:r><w:fldChar w:fldCharType="end"/></w:r>
          </w:sdtContent>
        </w:sdt>
      </w:p>
    `;

    const sdt = getInlineSdt(xml);
    expect(sdt.content[0].type).toBe("complexField");

    const serialized = serializeParagraph(parseParagraphXml(xml));
    expect(serialized).toContain("<w:sdt>");
    expect(serialized).toContain("<w:fldChar");
    expect(serialized).toContain(" PAGE ");
  });

  test("preserves a nested inline SDT inside SDT content through parse → serialize", () => {
    const xml = `
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:sdt>
          <w:sdtPr><w:alias w:val="outer"/></w:sdtPr>
          <w:sdtContent>
            <w:sdt>
              <w:sdtPr><w:alias w:val="inner"/></w:sdtPr>
              <w:sdtContent>
                <w:r><w:t>Nested text</w:t></w:r>
              </w:sdtContent>
            </w:sdt>
          </w:sdtContent>
        </w:sdt>
      </w:p>
    `;

    const sdt = getInlineSdt(xml);
    expect(sdt.content[0].type).toBe("inlineSdt");

    const serialized = serializeParagraph(parseParagraphXml(xml));
    expect(serialized.match(/<w:sdt>/gu)?.length).toBe(2);
    expect(serialized).toContain('w:val="outer"');
    expect(serialized).toContain('w:val="inner"');
    expect(serialized).toContain("Nested text");
  });

  test("preserves a math equation inside SDT content through parse → serialize", () => {
    const xml = `
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
           xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">
        <w:sdt>
          <w:sdtPr><w:alias w:val="equation-control"/></w:sdtPr>
          <w:sdtContent>
            <m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath>
          </w:sdtContent>
        </w:sdt>
      </w:p>
    `;

    const sdt = getInlineSdt(xml);
    expect(sdt.content[0].type).toBe("mathEquation");

    const serialized = serializeParagraph(parseParagraphXml(xml));
    expect(serialized).toContain("<w:sdt>");
    // The raw OMML XML should be round-tripped verbatim.
    expect(serialized).toContain("<m:oMath");
    expect(serialized).toContain("x+1");
  });

  test("preserves SDT-wrapped field through the full PM round-trip", () => {
    const xml = `
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:sdt>
          <w:sdtPr><w:alias w:val="title-control"/></w:sdtPr>
          <w:sdtContent>
            <w:fldSimple w:instr="TITLE">
              <w:r><w:t>Cached title</w:t></w:r>
            </w:fldSimple>
          </w:sdtContent>
        </w:sdt>
      </w:p>
    `;

    // parse → Document → PM → Document → serialize
    const paragraph = parseParagraphXml(xml);
    const baseDocument = {
      package: { document: { content: [paragraph] } } as Document["package"],
    } as Document;
    const pmDoc = toProseDoc(baseDocument);
    const roundTripped = fromProseDoc(pmDoc, baseDocument);

    const rtParagraph = roundTripped.package.document.content.find(
      (c): c is Paragraph => c.type === "paragraph",
    );
    expect(rtParagraph).toBeDefined();
    if (!rtParagraph) {
      return;
    }
    const sdt = rtParagraph.content[0];
    expect(sdt?.type).toBe("inlineSdt");
    if (sdt?.type !== "inlineSdt") {
      return;
    }
    expect(sdt.content[0]?.type).toBe("simpleField");

    const serialized = serializeParagraph(rtParagraph);
    expect(serialized).toContain("<w:sdt>");
    expect(serialized).toContain("TITLE");
    expect(serialized).toContain("Cached title");
  });

  test("keeps a plain run alongside a field inside the same SDT", () => {
    const xml = `
      <w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:sdt>
          <w:sdtPr><w:alias w:val="mixed"/></w:sdtPr>
          <w:sdtContent>
            <w:r><w:t xml:space="preserve">Page </w:t></w:r>
            <w:fldSimple w:instr="PAGE">
              <w:r><w:t>1</w:t></w:r>
            </w:fldSimple>
          </w:sdtContent>
        </w:sdt>
      </w:p>
    `;

    const sdt = getInlineSdt(xml);
    expect(sdt.content).toHaveLength(2);
    expect(sdt.content[0].type).toBe("run");
    expect(sdt.content[1].type).toBe("simpleField");

    const serialized = serializeParagraph(parseParagraphXml(xml));
    expect(serialized).toContain("Page ");
    expect(serialized).toContain("PAGE");
    expect(serialized).toContain("<w:fldChar");
  });
});
