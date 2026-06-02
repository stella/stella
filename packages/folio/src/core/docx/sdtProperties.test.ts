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

  test("accepts OOXML OnOff variants for w14:checked val (true / on / 1 / absent)", () => {
    // Word writes any of these forms; we previously only recognized "1"
    // and silently flipped state on save.
    const ns =
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"';
    expect(
      parseSdtPrXml(
        `<w:sdtPr ${ns}><w14:checkbox><w14:checked w14:val="true"/></w14:checkbox></w:sdtPr>`,
      ).checked,
    ).toBe(true);
    expect(
      parseSdtPrXml(
        `<w:sdtPr ${ns}><w14:checkbox><w14:checked w14:val="on"/></w14:checkbox></w:sdtPr>`,
      ).checked,
    ).toBe(true);
    expect(
      parseSdtPrXml(
        `<w:sdtPr ${ns}><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr>`,
      ).checked,
    ).toBe(true);
    // A bare <w14:checked/> with no val attribute also means true per OnOff.
    expect(
      parseSdtPrXml(
        `<w:sdtPr ${ns}><w14:checkbox><w14:checked/></w14:checkbox></w:sdtPr>`,
      ).checked,
    ).toBe(true);
    // Negations.
    expect(
      parseSdtPrXml(
        `<w:sdtPr ${ns}><w14:checkbox><w14:checked w14:val="false"/></w14:checkbox></w:sdtPr>`,
      ).checked,
    ).toBe(false);
    expect(
      parseSdtPrXml(
        `<w:sdtPr ${ns}><w14:checkbox><w14:checked w14:val="0"/></w14:checkbox></w:sdtPr>`,
      ).checked,
    ).toBe(false);
  });

  test("listItem with only w:value falls back to value as displayText", () => {
    const props = parseSdtPrXml(
      '<w:sdtPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:dropDownList><w:listItem w:value="ca"/><w:listItem w:value="ny" w:displayText="New York"/></w:dropDownList></w:sdtPr>',
    );
    expect(props.sdtType).toBe("dropdown");
    expect(props.listItems).toEqual([
      { displayText: "ca", value: "ca" },
      { displayText: "New York", value: "ny" },
    ]);
  });

  test("listItem with only w:displayText falls back to displayText as value", () => {
    const props = parseSdtPrXml(
      '<w:sdtPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:dropDownList><w:listItem w:displayText="Yes"/></w:dropDownList></w:sdtPr>',
    );
    expect(props.listItems).toEqual([{ displayText: "Yes", value: "Yes" }]);
  });

  test("respects w:showingPlcHdr OnOff val (false / off / 0)", () => {
    // The presence-implies-true semantics still applies, but an explicit
    // negation must be honored. Previously the parser flipped
    // `val="false"` back to `true` because it ignored the attribute.
    const ns =
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    expect(
      parseSdtPrXml(`<w:sdtPr ${ns}><w:showingPlcHdr/></w:sdtPr>`)
        .showingPlaceholder,
    ).toBe(true);
    expect(
      parseSdtPrXml(`<w:sdtPr ${ns}><w:showingPlcHdr w:val="true"/></w:sdtPr>`)
        .showingPlaceholder,
    ).toBe(true);
    expect(
      parseSdtPrXml(`<w:sdtPr ${ns}><w:showingPlcHdr w:val="false"/></w:sdtPr>`)
        .showingPlaceholder,
    ).toBe(false);
    expect(
      parseSdtPrXml(`<w:sdtPr ${ns}><w:showingPlcHdr w:val="0"/></w:sdtPr>`)
        .showingPlaceholder,
    ).toBe(false);
    expect(
      parseSdtPrXml(`<w:sdtPr ${ns}><w:showingPlcHdr w:val="off"/></w:sdtPr>`)
        .showingPlaceholder,
    ).toBe(false);
  });

  test("falls back to richText when the marker is unknown", () => {
    const props = parseSdtPrXml(
      '<w:sdtPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:appearance w15:val="boundingBox"/><w:tag w:val="t"/></w:sdtPr>',
    );
    expect(props.sdtType).toBe("richText");
    expect(props.tag).toBe("t");
  });
});
