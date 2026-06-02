/**
 * Tests for the shared SDT-properties parser.
 *
 * Focus areas not covered by the higher-level block-SDT parser tests:
 * recognising `w14:` / `w15:` prefixed marker elements (the most visible
 * one being `w14:checkbox`).
 */

import { describe, expect, test } from "bun:test";

import { parseSdtProperties } from "./sdtProperties";
import { parseXml } from "./xmlParser";

function parseSdtPrXml(xml: string) {
  const root = parseXml(xml);
  const sdtPr = root.elements?.[0];
  if (!sdtPr) {
    throw new TypeError("expected sdtPr root");
  }
  return parseSdtProperties(sdtPr);
}

describe("parseSdtProperties — prefixed marker elements", () => {
  test("recognizes w14:checkbox and returns sdtType=checkbox", () => {
    const props = parseSdtPrXml(
      '<w:sdtPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:tag w:val="agree"/><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr>',
    );
    expect(props.sdtType).toBe("checkbox");
    expect(props.checked).toBe(true);
    expect(props.tag).toBe("agree");
  });

  test("recognizes a w:date marker even on prefixed children", () => {
    const props = parseSdtPrXml(
      '<w:sdtPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:date w:fullDate="2026-06-02T00:00:00Z"><w:dateFormat w:val="d MMMM yyyy"/></w:date></w:sdtPr>',
    );
    expect(props.sdtType).toBe("date");
    expect(props.dateFormat).toBe("d MMMM yyyy");
    expect(props.dateValueISO).toBe("2026-06-02T00:00:00Z");
  });

  test("falls back to richText when the marker is unknown", () => {
    const props = parseSdtPrXml(
      '<w:sdtPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:appearance w15:val="boundingBox"/><w:tag w:val="t"/></w:sdtPr>',
    );
    expect(props.sdtType).toBe("richText");
    expect(props.tag).toBe("t");
  });
});
