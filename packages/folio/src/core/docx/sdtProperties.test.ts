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

  test("normalizes alt-prefix rawPropertiesXml to canonical w: on capture", () => {
    // A producer that binds the WordprocessingML namespace under `ns0`
    // emits `<ns0:sdtPr>…</ns0:sdtPr>` at parse time. Replaying that
    // verbatim into the serializer's output (which only declares the
    // canonical `w` / `w14` / `w15` prefixes at the document root)
    // would produce invalid XML with unresolved `xmlns:ns0` and Word
    // would refuse to open the saved DOCX. The captured raw snippet
    // should already use `w:` so the replay is self-contained.
    const ns =
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:ns0="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const props = parseSdtPrXml(
      `<ns0:sdtPr ${ns}><ns0:tag ns0:val="client"/><ns0:alias ns0:val="Client"/></ns0:sdtPr>`,
    );
    expect(props.tag).toBe("client");
    expect(props.alias).toBe("Client");
    expect(props.rawPropertiesXml).toBeDefined();
    // Replay must be canonical.
    expect(props.rawPropertiesXml).not.toContain("ns0:");
    expect(props.rawPropertiesXml).toContain("<w:sdtPr");
    expect(props.rawPropertiesXml).toContain('<w:tag w:val="client"/>');
  });

  test("reads placeholder docPart reference from the docPart's own w:val attribute", () => {
    // The parser used to look for a nested `<w:val>` child inside
    // `<w:docPart>`. The actual OOXML shape is `<w:docPart w:val="…"/>`,
    // so the placeholder reference was silently dropped.
    const ns =
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const props = parseSdtPrXml(
      `<w:sdtPr ${ns}><w:placeholder><w:docPart w:val="DefaultPlaceholder"/></w:placeholder></w:sdtPr>`,
    );
    expect(props.placeholder).toBe("DefaultPlaceholder");
  });

  test("reads top-level SDT property attrs under an alternative namespace prefix", () => {
    // Same prefix-tolerance theme as listItems and checkbox val: the
    // top-level w:tag / w:alias / w:id / w:lock readers used to be hard-
    // coded to the `w:` prefix, so docs that bound the namespace under
    // ns0 came back with undefined tag / alias / lock and could not be
    // addressed via getContentControls({ tag }).
    const ns =
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:ns0="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const props = parseSdtPrXml(
      `<w:sdtPr ${ns}><ns0:id ns0:val="42"/><ns0:tag ns0:val="client"/><ns0:alias ns0:val="Client Name"/><ns0:lock ns0:val="contentLocked"/></w:sdtPr>`,
    );
    expect(props.id).toBe(42);
    expect(props.tag).toBe("client");
    expect(props.alias).toBe("Client Name");
    expect(props.lock).toBe("contentLocked");
  });

  test("reads dropdown listItem attrs under an alternative namespace prefix", () => {
    // Same prefix-tolerance bug as checkbox val — `parseListItems` matched
    // `<ns0:listItem>` via local-name fallback but then read `w:displayText`
    // / `w:value`, which came back null and the item was silently dropped.
    // A dropdown bound under any non-`w` prefix would open with no options.
    const ns =
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:ns0="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const props = parseSdtPrXml(
      `<w:sdtPr ${ns}><w:dropDownList><ns0:listItem ns0:displayText="A" ns0:value="a"/><ns0:listItem ns0:displayText="B" ns0:value="b"/></w:dropDownList></w:sdtPr>`,
    );
    expect(props.sdtType).toBe("dropdown");
    expect(props.listItems).toEqual([
      { displayText: "A", value: "a" },
      { displayText: "B", value: "b" },
    ]);
  });

  test("reads checkbox val under an alternative namespace prefix", () => {
    // OOXML binds prefixes to URIs at the document root; a valid doc can
    // bind the w14 namespace under any prefix (here `ns0`). The marker
    // element matched fine via local-name fallback, but the val attribute
    // was missed because we only looked for `w14:val` / bare `val`. An
    // unchecked box was then parsed as checked.
    const ns =
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:ns0="http://schemas.microsoft.com/office/word/2010/wordml"';
    expect(
      parseSdtPrXml(
        `<w:sdtPr ${ns}><ns0:checkbox><ns0:checked ns0:val="0"/></ns0:checkbox></w:sdtPr>`,
      ).checked,
    ).toBe(false);
    expect(
      parseSdtPrXml(
        `<w:sdtPr ${ns}><ns0:checkbox><ns0:checked ns0:val="1"/></ns0:checkbox></w:sdtPr>`,
      ).checked,
    ).toBe(true);
    expect(
      parseSdtPrXml(
        `<w:sdtPr ${ns}><ns0:checkbox><ns0:checked ns0:val="false"/></ns0:checkbox></w:sdtPr>`,
      ).checked,
    ).toBe(false);
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
