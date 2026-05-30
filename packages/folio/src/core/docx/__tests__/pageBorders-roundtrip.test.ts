/**
 * Round-trip coverage for `<w:pgBorders>` (ECMA-376 §17.6.10) — parser
 * fidelity for every documented attribute/sub-element plus serializer
 * symmetry. Companion to the painter tests in
 * `layout-painter/renderPage-pageBorders.test.ts`.
 *
 * Custom art-border relationship ids (`w:id` and corner ids on a side) are
 * preserved through the round-trip even though folio does not paint art
 * glyphs; see the design doc at `/tmp/folio-page-borders-design.md`.
 */

import { describe, expect, test } from "bun:test";

import { parseSectionProperties } from "../sectionParser";
import { serializeSectionProperties } from "../serializer/sectionPropertiesSerializer";
import type { XmlElement } from "../xmlParser";
import { parseXmlDocument } from "../xmlParser";

const SECT_PR_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const parseSectPr = (inner: string) => {
  const node = parseXmlDocument(
    `<w:sectPr ${SECT_PR_NS}>${inner}</w:sectPr>`,
  ) as XmlElement | null;
  if (!node) {
    throw new Error("Failed to parse sectPr fixture");
  }
  return parseSectionProperties(node);
};

describe("pgBorders parser coverage", () => {
  test("parses display, offsetFrom, and zOrder attributes", () => {
    const section = parseSectPr(`
      <w:pgBorders w:display="firstPage" w:offsetFrom="page" w:zOrder="back">
        <w:top w:val="single" w:sz="4" w:space="24" w:color="000000"/>
      </w:pgBorders>
    `);

    expect(section.pageBorders?.display).toBe("firstPage");
    expect(section.pageBorders?.offsetFrom).toBe("page");
    expect(section.pageBorders?.zOrder).toBe("back");
  });

  test("parses all four sides independently with mixed styles", () => {
    const section = parseSectPr(`
      <w:pgBorders>
        <w:top w:val="single" w:sz="8" w:space="10" w:color="FF0000"/>
        <w:bottom w:val="double" w:sz="12" w:space="5" w:color="00FF00"/>
        <w:left w:val="dashed" w:sz="6" w:space="3" w:color="0000FF"/>
        <w:right w:val="dotted" w:sz="4" w:space="1" w:color="123456"/>
      </w:pgBorders>
    `);

    expect(section.pageBorders?.top).toEqual({
      style: "single",
      size: 8,
      space: 10,
      color: { rgb: "FF0000" },
    });
    expect(section.pageBorders?.bottom).toEqual({
      style: "double",
      size: 12,
      space: 5,
      color: { rgb: "00FF00" },
    });
    expect(section.pageBorders?.left).toEqual({
      style: "dashed",
      size: 6,
      space: 3,
      color: { rgb: "0000FF" },
    });
    expect(section.pageBorders?.right).toEqual({
      style: "dotted",
      size: 4,
      space: 1,
      color: { rgb: "123456" },
    });
  });

  test("parses auto color and theme color on a side", () => {
    const section = parseSectPr(`
      <w:pgBorders>
        <w:top w:val="single" w:sz="4" w:color="auto"/>
        <w:bottom w:val="single" w:sz="4" w:color="000000"
                  w:themeColor="accent1" w:themeTint="66" w:themeShade="BF"/>
      </w:pgBorders>
    `);

    expect(section.pageBorders?.top?.color).toEqual({ auto: true });
    expect(section.pageBorders?.bottom?.color).toEqual({
      rgb: "000000",
      themeColor: "accent1",
      themeTint: "66",
      themeShade: "BF",
    });
  });

  test("parses shadow and frame flags from `1` and `true`", () => {
    const section = parseSectPr(`
      <w:pgBorders>
        <w:top w:val="single" w:shadow="1" w:frame="true"/>
        <w:bottom w:val="single" w:shadow="true" w:frame="1"/>
      </w:pgBorders>
    `);

    expect(section.pageBorders?.top?.shadow).toBe(true);
    expect(section.pageBorders?.top?.frame).toBe(true);
    expect(section.pageBorders?.bottom?.shadow).toBe(true);
    expect(section.pageBorders?.bottom?.frame).toBe(true);
  });

  test("preserves custom art-border relationship ids for round-trip", () => {
    const section = parseSectPr(`
      <w:pgBorders>
        <w:top w:val="single" w:sz="20" w:space="24" w:color="auto"
               w:id="rId5" w:topLeft="rId6" w:topRight="rId7"/>
      </w:pgBorders>
    `);

    expect(section.pageBorders?.top?.artRelationshipId).toBe("rId5");
    expect(section.pageBorders?.top?.topLeftArtRelationshipId).toBe("rId6");
    expect(section.pageBorders?.top?.topRightArtRelationshipId).toBe("rId7");
  });

  test("preserves an unknown style as the raw string", () => {
    const section = parseSectPr(`
      <w:pgBorders>
        <w:top w:val="someExoticArtName" w:sz="4" w:color="000000"/>
      </w:pgBorders>
    `);

    expect(section.pageBorders?.top?.style).toBe("someExoticArtName");
  });

  test("treats `nil` and `none` styles as preserved no-op values", () => {
    const section = parseSectPr(`
      <w:pgBorders>
        <w:top w:val="nil"/>
        <w:bottom w:val="none"/>
        <w:left w:val="single" w:sz="4"/>
      </w:pgBorders>
    `);

    expect(section.pageBorders?.top?.style).toBe("nil");
    expect(section.pageBorders?.bottom?.style).toBe("none");
    expect(section.pageBorders?.left?.style).toBe("single");
  });

  test("ignores unknown display/offsetFrom/zOrder values", () => {
    const section = parseSectPr(`
      <w:pgBorders w:display="weirdMode" w:offsetFrom="bogus" w:zOrder="sideways">
        <w:top w:val="single"/>
      </w:pgBorders>
    `);

    expect(section.pageBorders?.display).toBeUndefined();
    expect(section.pageBorders?.offsetFrom).toBeUndefined();
    expect(section.pageBorders?.zOrder).toBeUndefined();
  });
});

describe("pgBorders serializer round-trip", () => {
  test("round-trips all attributes and one full-coverage side", () => {
    const section = parseSectPr(`
      <w:pgBorders w:display="allPages" w:offsetFrom="text" w:zOrder="front">
        <w:top w:val="single" w:sz="8" w:space="12" w:color="FF8800"
               w:themeColor="accent2" w:themeTint="40" w:themeShade="80"
               w:shadow="true" w:frame="true"/>
      </w:pgBorders>
    `);

    const xml = serializeSectionProperties(section);

    expect(xml).toContain('w:display="allPages"');
    expect(xml).toContain('w:offsetFrom="text"');
    expect(xml).toContain('w:zOrder="front"');
    expect(xml).toContain('w:val="single"');
    expect(xml).toContain('w:sz="8"');
    expect(xml).toContain('w:space="12"');
    expect(xml).toContain('w:color="FF8800"');
    expect(xml).toContain('w:themeColor="accent2"');
    expect(xml).toContain('w:themeTint="40"');
    expect(xml).toContain('w:themeShade="80"');
    expect(xml).toContain('w:shadow="true"');
    expect(xml).toContain('w:frame="true"');
  });

  test("emits each side once and only when set", () => {
    const xml = serializeSectionProperties({
      pageBorders: {
        top: { style: "single", size: 4 },
        bottom: { style: "double", size: 12 },
        left: { style: "none" },
        right: { style: "nil" },
      },
    });

    expect(xml).toContain('<w:top w:val="single"');
    expect(xml).toContain('<w:bottom w:val="double"');
    expect(xml).not.toContain("<w:left");
    expect(xml).not.toContain("<w:right");
  });

  test("round-trips custom art-border relationship ids", () => {
    const section = parseSectPr(`
      <w:pgBorders w:offsetFrom="page">
        <w:top w:val="single" w:sz="20" w:space="24" w:color="auto"
               w:id="rId5" w:topLeft="rId6" w:topRight="rId7"/>
        <w:bottom w:val="single" w:id="rId8" w:bottomLeft="rId9"
                  w:bottomRight="rId10"/>
      </w:pgBorders>
    `);

    const xml = serializeSectionProperties(section);
    expect(xml).toContain('w:id="rId5"');
    expect(xml).toContain('w:topLeft="rId6"');
    expect(xml).toContain('w:topRight="rId7"');
    expect(xml).toContain('w:id="rId8"');
    expect(xml).toContain('w:bottomLeft="rId9"');
    expect(xml).toContain('w:bottomRight="rId10"');
  });

  test("round-trips auto color and theme-color attributes", () => {
    const section = parseSectPr(`
      <w:pgBorders>
        <w:top w:val="single" w:color="auto"/>
        <w:bottom w:val="single" w:themeColor="accent3"/>
      </w:pgBorders>
    `);

    const xml = serializeSectionProperties(section);
    expect(xml).toContain('w:color="auto"');
    expect(xml).toContain('w:themeColor="accent3"');
  });

  test("preserves an attributes-only pgBorders element through round-trip", () => {
    // Word emits `<w:pgBorders w:offsetFrom="text" w:display="allPages"/>`
    // with no child sides to signal "remove all page borders, keep the
    // section-level placement". Dropping the element loses that intent.
    const section = parseSectPr(`
      <w:pgBorders w:display="allPages" w:offsetFrom="text"/>
    `);

    const xml = serializeSectionProperties(section);
    expect(xml).toContain(
      '<w:pgBorders w:display="allPages" w:offsetFrom="text"/>',
    );
  });

  test("skips pgBorders entirely when neither attributes nor sides are set", () => {
    const xml = serializeSectionProperties({ pageBorders: {} });
    expect(xml).not.toContain("pgBorders");
  });
});
