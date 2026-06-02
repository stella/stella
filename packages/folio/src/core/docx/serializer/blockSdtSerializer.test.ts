/**
 * Round-trip tests for the block-level SDT serializer.
 *
 * Parse → re-serialize must preserve the original `<w:sdtPr>` bytes so
 * unmodeled OOXML features (data binding, repeating sections, sdtEndPr)
 * survive a save cycle. Picked up from upstream eigenpal/docx-editor#653.
 */

import { describe, expect, test } from "bun:test";

import type { BlockContent, BlockSdt } from "../../types/document";
import { parseBlockContent } from "../blockContentParser";
import { parseXml } from "../xmlParser";
import { serializeBlockSdt } from "./blockSdtSerializer";

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';

function parseBlocks(bodyXml: string): BlockContent[] {
  const root = parseXml(bodyXml);
  const body = root.elements?.[0];
  if (!body) {
    throw new Error("expected root body element");
  }
  return parseBlockContent(body, null, null, null, null, null);
}

function noChildSerializer(_block: BlockContent): string {
  return "<w:p/>";
}

describe("serializeBlockSdt — raw sdtPr replay", () => {
  test("preserves w:dataBinding through parse → serialize", () => {
    const blocks = parseBlocks(`<w:body ${NS}>
      <w:sdt>
        <w:sdtPr>
          <w:tag w:val="party-name"/>
          <w:dataBinding w:xpath="/contract/party[1]/name" w:storeItemID="{ABC}"/>
        </w:sdtPr>
        <w:sdtContent><w:p/></w:sdtContent>
      </w:sdt>
    </w:body>`);

    const first = blocks[0];
    if (!first || first.type !== "blockSdt") {
      throw new Error(`expected blockSdt, got ${String(first?.type)}`);
    }
    const sdt = first;
    const xml = serializeBlockSdt(sdt, noChildSerializer);
    expect(xml).toContain("<w:dataBinding");
    expect(xml).toContain('w:xpath="/contract/party[1]/name"');
    expect(xml).toContain('w:storeItemID="{ABC}"');
  });

  test("preserves w15:repeatingSection through parse → serialize", () => {
    const blocks = parseBlocks(`<w:body ${NS}>
      <w:sdt>
        <w:sdtPr>
          <w:tag w:val="parties"/>
          <w15:repeatingSection/>
        </w:sdtPr>
        <w:sdtContent><w:p/></w:sdtContent>
      </w:sdt>
    </w:body>`);
    const first = blocks[0];
    if (!first || first.type !== "blockSdt") {
      throw new Error(`expected blockSdt, got ${String(first?.type)}`);
    }
    const sdt = first;
    const xml = serializeBlockSdt(sdt, noChildSerializer);
    expect(xml).toContain("w15:repeatingSection");
  });

  test("replays sdtEndPr verbatim", () => {
    const blocks = parseBlocks(`<w:body ${NS}>
      <w:sdt>
        <w:sdtPr><w:tag w:val="signature"/></w:sdtPr>
        <w:sdtEndPr><w:rPr><w:b/></w:rPr></w:sdtEndPr>
        <w:sdtContent><w:p/></w:sdtContent>
      </w:sdt>
    </w:body>`);
    const first = blocks[0];
    if (!first || first.type !== "blockSdt") {
      throw new Error(`expected blockSdt, got ${String(first?.type)}`);
    }
    const sdt = first;
    const xml = serializeBlockSdt(sdt, noChildSerializer);
    expect(xml).toContain("<w:sdtEndPr>");
    expect(xml).toContain("<w:b");
  });

  test("fallback sdtPr emits dropdown type marker + listItems for programmatic controls", () => {
    // A BlockSdt constructed without rawPropertiesXml (e.g. a template
    // engine that builds the control programmatically) must still encode
    // its type so Word reopens it as the right control kind.
    const sdt: BlockSdt = {
      type: "blockSdt",
      properties: {
        sdtType: "dropdown",
        tag: "state",
        listItems: [
          { displayText: "California", value: "ca" },
          { displayText: "New York", value: "ny" },
        ],
      },
      content: [],
    };
    const xml = serializeBlockSdt(sdt, noChildSerializer);
    expect(xml).toContain("<w:dropDownList>");
    expect(xml).toContain('w:displayText="California"');
    expect(xml).toContain('w:value="ca"');
    expect(xml).toContain('w:value="ny"');
    expect(xml).toContain("</w:dropDownList>");
  });

  test("fallback sdtPr emits w:date with fullDate + dateFormat for date controls", () => {
    const sdt: BlockSdt = {
      type: "blockSdt",
      properties: {
        sdtType: "date",
        tag: "effective",
        dateFormat: "d MMMM yyyy",
        dateValueISO: "2026-06-02T00:00:00Z",
      },
      content: [],
    };
    const xml = serializeBlockSdt(sdt, noChildSerializer);
    expect(xml).toContain('w:fullDate="2026-06-02T00:00:00Z"');
    expect(xml).toContain('<w:dateFormat w:val="d MMMM yyyy"/>');
  });

  test("fallback sdtPr emits w14:checkbox with w14:checked for checkbox controls", () => {
    const sdt: BlockSdt = {
      type: "blockSdt",
      properties: { sdtType: "checkbox", tag: "agree", checked: true },
      content: [],
    };
    const xml = serializeBlockSdt(sdt, noChildSerializer);
    expect(xml).toContain("<w14:checkbox>");
    expect(xml).toContain('<w14:checked w14:val="1"/>');
  });

  test("falls back to a minimal sdtPr when no raw snapshot exists", () => {
    // Mirrors a programmatically-constructed BlockSdt (no parse cycle), so
    // the serializer can't replay raw XML and must synthesize from props.
    const sdt: BlockSdt = {
      type: "blockSdt",
      properties: {
        sdtType: "richText",
        alias: "Synthetic & <wrapped>",
        tag: "synthetic",
        lock: "contentLocked",
      },
      content: [],
    };
    const xml = serializeBlockSdt(sdt, noChildSerializer);
    expect(xml).toContain('<w:alias w:val="Synthetic &amp; &lt;wrapped&gt;"/>');
    expect(xml).toContain('<w:tag w:val="synthetic"/>');
    expect(xml).toContain('<w:lock w:val="contentLocked"/>');
  });
});
