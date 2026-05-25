import { describe, expect, test } from "bun:test";

import { parseSectionProperties } from "../sectionParser";
import type { XmlElement } from "../xmlParser";
import { parseXmlDocument } from "../xmlParser";
import { serializeSectionProperties } from "./sectionPropertiesSerializer";

const parseSectPr = (xml: string) => {
  const node = parseXmlDocument(xml) as XmlElement | null;
  if (!node) {
    throw new Error("Failed to parse section properties fixture");
  }
  return parseSectionProperties(node);
};

describe("serializeSectionProperties", () => {
  test("keeps titlePg before bidi in sectPr order", () => {
    const xml = serializeSectionProperties({
      titlePg: true,
      bidi: true,
    });

    expect(xml.indexOf("<w:titlePg/>")).toBeGreaterThanOrEqual(0);
    expect(xml.indexOf("<w:bidi/>")).toBeGreaterThan(
      xml.indexOf("<w:titlePg/>"),
    );
  });

  test("does not serialize evenAndOddHeaders inside sectPr", () => {
    const xml = serializeSectionProperties({
      evenAndOddHeaders: true,
      titlePg: true,
    });

    expect(xml).toContain("<w:titlePg/>");
    expect(xml).not.toContain("<w:evenAndOddHeaders/>");
  });

  test("emits empty sectPr only for truly empty section properties", () => {
    expect(serializeSectionProperties({})).toBe("<w:sectPr/>");
    expect(
      serializeSectionProperties(
        parseSectPr(`
          <w:sectPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>
        `),
      ),
    ).toBe("<w:sectPr/>");
    expect(
      serializeSectionProperties(
        parseSectPr(`
          <w:sectPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:textDirection w:val="unknown"/>
          </w:sectPr>
        `),
      ),
    ).toBe("");
    expect(
      serializeSectionProperties(
        parseSectPr(`
          <w:sectPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:sectPrChange/>
          </w:sectPr>
        `),
      ),
    ).toBe("");
    expect(
      serializeSectionProperties({
        ...parseSectPr(`
          <w:sectPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:sectPrChange/>
          </w:sectPr>
        `),
      }),
    ).toBe("");
  });

  test("preserves unknown page border styles for fallback rendering", () => {
    const section = parseSectPr(`
      <w:sectPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
        <w:pgBorders>
          <w:top w:val="dashDotDot" w:sz="8" w:color="00AAFF"/>
        </w:pgBorders>
      </w:sectPr>
    `);

    expect(section.pageBorders?.top).toMatchObject({
      color: { rgb: "00AAFF" },
      size: 8,
      style: "dashDotDot",
    });
  });

  test("serializes parsed background and text direction properties", () => {
    expect(
      serializeSectionProperties({
        background: {
          color: { rgb: "FFFFFF" },
          themeColor: "background1",
          themeTint: "66",
          themeShade: "BF",
        },
      }),
    ).toBe(
      '<w:sectPr><w:background w:color="FFFFFF" w:themeColor="background1" w:themeTint="66" w:themeShade="BF"/></w:sectPr>',
    );

    expect(
      serializeSectionProperties(
        parseSectPr(`
          <w:sectPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:background w:color="F2F2F2" w:themeColor="background1"/>
          </w:sectPr>
        `),
      ),
    ).toBe(
      '<w:sectPr><w:background w:color="F2F2F2" w:themeColor="background1"/></w:sectPr>',
    );

    expect(
      serializeSectionProperties(
        parseSectPr(`
          <w:sectPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:textDirection w:val="tbRl"/>
          </w:sectPr>
        `),
      ),
    ).toBe('<w:sectPr><w:textDirection w:val="tbRl"/></w:sectPr>');

    expect(
      serializeSectionProperties(
        parseSectPr(`
          <w:sectPr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:textDirection w:val="lrTbV"/>
          </w:sectPr>
        `),
      ),
    ).toBe('<w:sectPr><w:textDirection w:val="lrTbV"/></w:sectPr>');
  });

  test("serializes parsed direct section properties that have lossless fields", () => {
    expect(
      serializeSectionProperties(
        parseSectPr(`
          <w:sectPr
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
          >
            <w:pgNumType w:fmt="decimal" w:start="3" w:chapStyle="2" w:chapSep="hyphen"/>
            <w:formProt/>
            <w:noEndnote w:val="0"/>
            <w:rtlGutter/>
            <w:printerSettings r:id="rIdPrinter"/>
          </w:sectPr>
        `),
      ),
    ).toBe(
      '<w:sectPr><w:pgNumType w:fmt="decimal" w:start="3" w:chapStyle="2" w:chapSep="hyphen"/><w:formProt/><w:noEndnote w:val="0"/><w:rtlGutter/><w:printerSettings r:id="rIdPrinter"/></w:sectPr>',
    );
  });

  test("round-trips section footnote columns", () => {
    const section = parseSectPr(`
      <w:sectPr
        xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
        xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"
      >
        <w15:footnoteColumns w:val="2"/>
      </w:sectPr>
    `);

    expect(section.footnoteColumns).toBe(2);
    expect(serializeSectionProperties(section)).toBe(
      '<w:sectPr><w15:footnoteColumns w:val="2"/></w:sectPr>',
    );
  });
});
