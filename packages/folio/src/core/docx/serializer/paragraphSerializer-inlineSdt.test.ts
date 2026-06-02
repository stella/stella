/**
 * Round-trip tests for inline SDTs through the paragraph serializer.
 *
 * Focus: the inline `<w:sdt>` date path now emits `w:date@w:fullDate`
 * separately from the `<w:dateFormat w:val>` child — previously the
 * display format was written into the bound-value slot (and the ISO
 * value was lost).
 */

import { describe, expect, test } from "bun:test";

import { parseParagraph } from "../paragraphParser";
import type { XmlElement } from "../xmlParser";
import { parseXmlDocument } from "../xmlParser";
import { serializeParagraph } from "./paragraphSerializer";

function parseParagraphXml(xml: string) {
  const root = parseXmlDocument(xml) as XmlElement | null;
  if (!root) {
    throw new Error("Failed to parse paragraph XML fixture");
  }
  return parseParagraph(root, null, null, null, null, null);
}

describe("serializeParagraph — inline date SDT round-trip", () => {
  test("writes w:fullDate and w:dateFormat into separate elements", () => {
    const paragraph = parseParagraphXml(
      '<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        "<w:sdt><w:sdtPr>" +
        '<w:tag w:val="effective"/>' +
        '<w:date w:fullDate="2026-06-02T00:00:00Z">' +
        '<w:dateFormat w:val="d MMMM yyyy"/>' +
        "</w:date>" +
        "</w:sdtPr><w:sdtContent>" +
        "<w:r><w:t>2 June 2026</w:t></w:r>" +
        "</w:sdtContent></w:sdt></w:p>",
    );
    const out = serializeParagraph(paragraph);
    // The bound ISO date lives on `w:date@w:fullDate`.
    expect(out).toContain('w:fullDate="2026-06-02T00:00:00Z"');
    // The display format lives on `<w:dateFormat w:val>`.
    expect(out).toContain('<w:dateFormat w:val="d MMMM yyyy"/>');
    // The format string must not leak into the fullDate attribute.
    expect(out).not.toContain('w:fullDate="d MMMM yyyy"');
  });

  test("emits <w:date/> alone when neither dateValueISO nor dateFormat is modeled", () => {
    const paragraph = parseParagraphXml(
      '<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:sdt><w:sdtPr><w:tag w:val="placeholder"/><w:date/></w:sdtPr>' +
        "<w:sdtContent><w:r><w:t>Click here to pick a date</w:t></w:r></w:sdtContent></w:sdt></w:p>",
    );
    const out = serializeParagraph(paragraph);
    expect(out).toContain("<w:date/>");
    expect(out).not.toContain('w:fullDate="');
  });
});
