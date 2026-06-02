/**
 * Regression tests for block-level SDT preservation.
 *
 * Pre-change behaviour: `<w:sdt>` block wrappers were flattened on parse,
 * dropping the control entirely (no properties, no identity, no round-trip).
 * Now the parser emits a `BlockSdt` carrying the modeled `SdtProperties`
 * plus a verbatim `rawPropertiesXml` snapshot of `<w:sdtPr>` so unmodeled
 * OOXML features (data binding, repeating sections, sdtEndPr) round-trip.
 *
 * Picked up from upstream eigenpal/docx-editor#653.
 */

import { describe, expect, test } from "bun:test";

import type { BlockContent, BlockSdt } from "../types/document";
import { parseBlockContent } from "./blockContentParser";
import { parseXml } from "./xmlParser";

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"';

function parseBody(xml: string) {
  const root = parseXml(xml);
  const body = root.elements?.[0];
  if (!body) {
    throw new Error("expected root body element");
  }
  return parseBlockContent(body, null, null, null, null, null);
}

function expectBlockSdt(block: BlockContent | undefined): BlockSdt {
  if (!block || block.type !== "blockSdt") {
    throw new Error(`expected blockSdt, got ${String(block?.type)}`);
  }
  return block;
}

describe("parseBlockContent — block-level w:sdt preservation", () => {
  test("emits a BlockSdt with modeled properties and raw sdtPr", () => {
    const xml = `<w:body ${NS}>
      <w:sdt>
        <w:sdtPr>
          <w:alias w:val="Effective Date"/>
          <w:tag w:val="effective-date"/>
          <w:id w:val="123456"/>
          <w:lock w:val="contentLocked"/>
        </w:sdtPr>
        <w:sdtContent>
          <w:p><w:r><w:t>2 June 2026</w:t></w:r></w:p>
        </w:sdtContent>
      </w:sdt>
    </w:body>`;

    const content = parseBody(xml);
    expect(content).toHaveLength(1);
    const sdt = expectBlockSdt(content[0]);
    expect(sdt.type).toBe("blockSdt");
    expect(sdt.properties.alias).toBe("Effective Date");
    expect(sdt.properties.tag).toBe("effective-date");
    expect(sdt.properties.id).toBe(123_456);
    expect(sdt.properties.lock).toBe("contentLocked");
    // Raw sdtPr captured for the serializer to replay verbatim.
    expect(sdt.properties.rawPropertiesXml).toContain("<w:alias");
    expect(sdt.properties.rawPropertiesXml).toContain("<w:tag");
    expect(sdt.properties.rawPropertiesXml).toContain("<w:lock");
    // Nested paragraph survives.
    expect(sdt.content).toHaveLength(1);
    expect(sdt.content[0]?.type).toBe("paragraph");
  });

  test("preserves unmodeled w15:repeatingSection markers via rawPropertiesXml", () => {
    const xml = `<w:body ${NS}>
      <w:sdt>
        <w:sdtPr>
          <w:tag w:val="parties"/>
          <w15:repeatingSection/>
        </w:sdtPr>
        <w:sdtContent>
          <w:p/>
        </w:sdtContent>
      </w:sdt>
    </w:body>`;

    const content = parseBody(xml);
    const sdt = expectBlockSdt(content[0]);
    expect(sdt.type).toBe("blockSdt");
    // Modeled type stays "richText" (we do not model w15:repeatingSection),
    // but the raw XML carries it so the serializer round-trips it.
    expect(sdt.properties.rawPropertiesXml).toContain("w15:repeatingSection");
  });

  test("captures w:sdtEndPr verbatim into rawEndPropertiesXml", () => {
    const xml = `<w:body ${NS}>
      <w:sdt>
        <w:sdtPr><w:tag w:val="signature"/></w:sdtPr>
        <w:sdtEndPr><w:rPr><w:b/></w:rPr></w:sdtEndPr>
        <w:sdtContent><w:p/></w:sdtContent>
      </w:sdt>
    </w:body>`;

    const content = parseBody(xml);
    const sdt = expectBlockSdt(content[0]);
    expect(sdt.properties.rawEndPropertiesXml).toContain("<w:rPr>");
    expect(sdt.properties.rawEndPropertiesXml).toContain("<w:b");
  });

  test("preserves nested block SDTs (sdt-inside-sdt)", () => {
    const xml = `<w:body ${NS}>
      <w:sdt>
        <w:sdtPr><w:tag w:val="outer"/></w:sdtPr>
        <w:sdtContent>
          <w:sdt>
            <w:sdtPr><w:tag w:val="inner"/></w:sdtPr>
            <w:sdtContent>
              <w:p><w:r><w:t>nested</w:t></w:r></w:p>
            </w:sdtContent>
          </w:sdt>
        </w:sdtContent>
      </w:sdt>
    </w:body>`;

    const content = parseBody(xml);
    const outer = expectBlockSdt(content[0]);
    expect(outer.properties.tag).toBe("outer");
    expect(outer.content).toHaveLength(1);
    const inner = expectBlockSdt(outer.content[0]);
    expect(inner.type).toBe("blockSdt");
    expect(inner.properties.tag).toBe("inner");
  });

  test("wraps a SDT around a table and preserves the table inside", () => {
    const xml = `<w:body ${NS}>
      <w:sdt>
        <w:sdtPr><w:tag w:val="party-block"/></w:sdtPr>
        <w:sdtContent>
          <w:tbl>
            <w:tblPr/>
            <w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid>
            <w:tr><w:tc><w:p/></w:tc></w:tr>
          </w:tbl>
        </w:sdtContent>
      </w:sdt>
    </w:body>`;

    const content = parseBody(xml);
    const sdt = expectBlockSdt(content[0]);
    expect(sdt.content).toHaveLength(1);
    expect(sdt.content[0]?.type).toBe("table");
  });

  test("an empty <w:sdtContent> still emits a BlockSdt with no children", () => {
    const xml = `<w:body ${NS}>
      <w:sdt>
        <w:sdtPr><w:tag w:val="empty"/></w:sdtPr>
        <w:sdtContent/>
      </w:sdt>
    </w:body>`;

    const content = parseBody(xml);
    const sdt = expectBlockSdt(content[0]);
    expect(sdt.type).toBe("blockSdt");
    expect(sdt.content).toHaveLength(0);
  });
});
